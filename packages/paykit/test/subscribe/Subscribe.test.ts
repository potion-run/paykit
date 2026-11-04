import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Subscribe } from "../../src/Subscribe.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { completeCheckout } from "../../src/Webhooks.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier, proTier] }));
const account = "acct_checkout";

const ModelWorld = PaykitModel.layer(
  PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
).pipe(Layer.provide(Domain.InMemory));

const withMemory = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  Effect.provide(
    effect,
    Layer.mergeAll(ModelWorld, catalogLayer(testCatalog), PaymentsMemory().payments),
  ) as Effect.Effect<A, E, never>;

const withManual = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  Effect.provide(
    effect,
    Layer.mergeAll(ModelWorld, catalogLayer(testCatalog), PaymentsManual().payments),
  ) as Effect.Effect<A, E, never>;

const withNoProvider = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  Effect.provide(effect, Layer.mergeAll(ModelWorld, catalogLayer(testCatalog))) as Effect.Effect<
    A,
    E,
    never
  >;

const state = Effect.gen(function* () {
  const subscription = yield* Subscription;
  return yield* subscription.state(Subscription.ref(account));
});

describe("Subscribe purchase path", () => {
  it.live("activates a free tier immediately", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const started = yield* subscribe({ account, tier: "free" });
      expect(started).toEqual({ activated: true });
      expect(yield* state).toMatchObject({ _tag: "Subscribed", tier: "free" });
    }).pipe(withMemory),
  );

  it.live("opens a hosted checkout and stores its reference before standing exists", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const started = yield* subscribe({ account, tier: "pro" });
      expect("url" in started).toBe(true);
      const current = yield* state;
      expect(current._tag).toBe("Unsubscribed");
      if (current._tag === "Unsubscribed") {
        expect(current.refs.memory?.checkout).toContain("checkout");
      }
    }).pipe(withMemory),
  );

  it.live("a checkout_completed webhook activates and keeps the reference", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      yield* subscribe({ account, tier: "pro" });
      const action = yield* completeCheckout({
        id: "evt_checkout_1",
        provider: "memory",
        account,
        tier: "pro",
      });
      expect(action).toBe("activated");
      const current = yield* state;
      expect(current._tag).toBe("Subscribed");
      if (current._tag === "Subscribed") {
        expect(current.status).toBe("active");
        expect(current.refs.memory?.checkout).toContain("checkout");
      }
    }).pipe(withMemory),
  );

  it.live("falls back to an invoice when the provider has no hosted checkout", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const started = yield* subscribe({ account, tier: "pro" });
      expect("invoiceId" in started).toBe(true);
      const current = yield* state;
      if (current._tag === "Unsubscribed") {
        expect(current.refs.manual?.checkout).toContain("invoice");
      }
    }).pipe(withManual),
  );

  it.live("a priced checkout without a provider fails typed", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const exit = yield* Effect.exit(subscribe({ account, tier: "pro" }));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("ProviderCapabilityMissing");
      }
    }).pipe(withNoProvider),
  );

  it("the catalog has a priced pro tier and a free tier", () => {
    expect(allowancesOf(testCatalog, "pro")?.messages.included).toBe(2000);
    expect(allowancesOf(testCatalog, "free")?.messages.included).toBe(100);
  });
});
