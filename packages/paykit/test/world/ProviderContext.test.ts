import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import {
  Payments,
  PaymentsProvider,
  PaymentsRouter,
  Portal,
  providerSet,
  resolveProvider,
  Subscribe,
} from "../../src/index.ts";
import type { MoneyProvider } from "../../src/Payments.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { world } from "../../src/World.ts";

const testCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [tier({ id: "free", grants: [allowance(messages, { included: 100 })] })],
  }),
);

const priced = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [
      tier({ id: "free", grants: [allowance(messages, { included: 100 })] }),
      tier({
        id: "pro",
        price: { amount: 1_900, currency: "usd", interval: "month" },
        grants: [allowance(messages, { included: 2_000 })],
      }),
    ],
  }),
);

const account = Subscription.ref("acct_provider_context").id;

/**
 * A provider whose `payments` layer counts its builds. `Layer.tap` observes the
 * build without changing the services, so the `PaymentsProvider` a `Subscribe`
 * reads is still in the context — a wrapper built around `Payments` alone would
 * silently drop it.
 */
const counting = (name: string) => {
  const memory = PaymentsMemory();
  let builds = 0;

  const payments = memory.payments.pipe(
    Layer.tap(() =>
      Effect.sync(() => {
        builds += 1;
      }),
    ),
  );

  return {
    provider: { ...memory, name, payments } satisfies MoneyProvider,
    builds: () => builds,
  };
};

describe("the provider set a world builds", () => {
  it.live("builds each provider's payments once, not once per command", () =>
    Effect.gen(function* () {
      const first = counting("first");
      const second = counting("second");

      yield* Effect.gen(function* () {
        const portal = yield* Portal;

        // Twenty money commands, each resolving a provider. Before the context
        // was built with the world, every one of them rebuilt the chosen
        // provider's layer: twenty builds for twenty calls.
        for (let call = 0; call < 20; call += 1) {
          yield* (yield* portal(account))();
        }
      }).pipe(
        Effect.provide(
          world({
            catalog: testCatalog,
            guards: InsecureDevGuards,
            providers: [first.provider, second.provider],
          }),
        ),
      );

      expect(first.builds()).toBe(1);
      expect(second.builds()).toBe(1);
    }),
  );

  it.live("builds a single provider once and keeps its services in the world", () =>
    Effect.gen(function* () {
      const only = counting("only");

      yield* Effect.gen(function* () {
        // The context, not the layer, is merged outward: a route beside the
        // world and a command resolving the provider share one build.
        expect(Option.isSome(yield* Effect.serviceOption(Payments))).toBe(true);

        const portal = yield* Portal;

        yield* (yield* portal(account))();
        yield* (yield* portal(account))();
      }).pipe(
        Effect.provide(
          world({
            catalog: testCatalog,
            guards: InsecureDevGuards,
            providers: [only.provider],
          }),
        ),
      );

      expect(only.builds()).toBe(1);
    }),
  );

  it.live("keeps one build: the world's Payments is the instance a command resolves", () =>
    Effect.gen(function* () {
      const only = counting("only");

      yield* Effect.gen(function* () {
        const fromWorld = yield* Payments;
        const set = yield* PaymentsRouter;

        const resolved =
          resolveProvider(set, {}) ?? (yield* Effect.die("expected the fallback provider"));

        const fromContext = yield* Effect.provide(Payments, resolved.context);

        // Merging the layer beside the world would build a second instance and
        // shadow this one, which is why a world exposes the context instead.
        expect(fromContext).toBe(fromWorld);
      }).pipe(
        Effect.provide(
          world({
            catalog: testCatalog,
            guards: InsecureDevGuards,
            providers: [only.provider],
          }),
        ),
      );
    }),
  );

  it.live("subscribes under the provider the router names", () =>
    Effect.gen(function* () {
      const first = counting("first");
      const second = counting("second");

      yield* Effect.gen(function* () {
        const subscribe = yield* Subscribe;

        // A priced tier is a purchase, so `Subscribe` runs the whole vendor
        // path on the context it is given and keys the ref by the provider the
        // router resolved — not by the first one in the list. That the context
        // still carries `PaymentsProvider` is the test below's job: this one
        // would pass on a context holding `Payments` alone, because the name
        // comes from the router.
        yield* (yield* subscribe(account))({ tier: "pro" });

        const state = yield* (yield* Subscription).state(Subscription.ref(account));

        expect(Object.keys(state.refs)).toEqual(["first"]);
      }).pipe(
        Effect.provide(
          world({
            catalog: priced,
            guards: InsecureDevGuards,
            providers: [first.provider, second.provider],
          }),
        ),
      );
    }),
  );

  it.effect("resolves the provider a ref names, with the context built for it", () =>
    Effect.gen(function* () {
      const first = counting("first");
      const second = counting("second");
      const set = yield* providerSet([first.provider, second.provider]);

      const chosen = resolveProvider(set, { second: {} });
      const resolved = chosen ?? (yield* Effect.die("expected a provider for the named ref"));

      expect(resolved.provider.name).toBe("second");

      // The resolution returns the context built for that provider — the same
      // entry the world merged — not the fallback's and not a fresh build.
      expect(resolved.context).toBe(set.contexts.get("second"));

      // And the context carries everything the layer provides, not just
      // `Payments`: `Subscribe` reads `PaymentsProvider` from it.
      expect(
        Option.isSome(
          yield* Effect.provide(Effect.serviceOption(PaymentsProvider), resolved.context),
        ),
      ).toBe(true);

      // An account with no refs, or one naming nothing this world runs, is
      // served by the fallback.
      expect(resolveProvider(set, {})?.provider.name).toBe("first");
      expect(resolveProvider(set, { unknown: {} })?.provider.name).toBe("first");

      // A local-only world has no provider to resolve.
      expect(resolveProvider(yield* providerSet([]), {})).toBeNull();
    }),
  );
});
