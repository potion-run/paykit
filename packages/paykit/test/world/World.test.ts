import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { Session } from "../../src/Auth/Guards.ts";
import { GrantCredits } from "../../src/Billing/Admin.binding.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { BillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogService } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { Payments, PaymentsRouter } from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { tier } from "../../src/Tier.ts";
import { world, type PaykitWorldOptions } from "../../src/World.ts";

const testCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [tier({ id: "free", grants: [allowance(messages, { included: 100 })] })],
  }),
);

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

const pricedCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [
      tier({
        id: "pro",
        price: proPrice,
        grants: [allowance(messages, { included: 100, overage: "bill" })],
      }),
    ],
  }),
);

/** Build a world and report the tagged error it refused with, if any. */
const refusalOf = (options: PaykitWorldOptions) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.serviceOption(CatalogService).pipe(Effect.provide(world(options))),
    );

    return Exit.isFailure(exit) ? Option.getOrNull(Cause.findErrorOption(exit.cause)) : null;
  });

/** Is this service in the context the world built? */
const provided = <A extends { readonly key: string }>(tag: A) =>
  Effect.gen(function* () {
    const held = yield* Effect.serviceOption(tag as never);

    return Option.isSome(held);
  });

type IsAny<T> = 0 extends 1 & T ? true : false;

type Provides<L extends Layer.Any, S> = [Extract<Layer.Success<L>, S>] extends [never]
  ? false
  : true;

type TenantWorld = ReturnType<typeof world<never, never, "tenant">>;

type BothWorld = ReturnType<typeof world<never, never, "both">>;

type TenantSuccess = Layer.Success<TenantWorld>;

const _typed: IsAny<TenantSuccess> = false;
const _tenantHasCheck: Provides<TenantWorld, Check> = true;
const _tenantHasNoGrant: Provides<TenantWorld, GrantCredits> = false;
const _bothHasGrant: Provides<BothWorld, GrantCredits> = true;

describe("world", () => {
  it.live("provides the tenant bindings, the catalog, the store and the guards", () =>
    Effect.gen(function* () {
      expect(yield* provided(Check)).toBe(true);
      expect(yield* provided(CatalogService)).toBe(true);
      expect(yield* provided(BillingReadStore)).toBe(true);
      expect(yield* provided(Session)).toBe(true);
      expect(yield* provided(GrantCredits)).toBe(false);
    }).pipe(Effect.provide(world({ catalog: testCatalog, guards: InsecureDevGuards }))),
  );

  it.live("adds the operator bindings when the process serves them", () =>
    Effect.gen(function* () {
      expect(yield* provided(Check)).toBe(true);
      expect(yield* provided(GrantCredits)).toBe(true);
    }).pipe(
      Effect.provide(world({ catalog: testCatalog, guards: InsecureDevGuards, bindings: "both" })),
    ),
  );

  it.live("serves no binding when the process only hosts the model", () =>
    Effect.gen(function* () {
      expect(yield* provided(Check)).toBe(false);
      expect(yield* provided(GrantCredits)).toBe(false);
      expect(yield* provided(CatalogService)).toBe(true);
    }).pipe(
      Effect.provide(world({ catalog: testCatalog, guards: InsecureDevGuards, bindings: "none" })),
    ),
  );

  it.live("accepts the catalog declaration, so a runtime needs no Effect.runSync", () =>
    Effect.gen(function* () {
      expect(yield* provided(Check)).toBe(true);
      expect(yield* provided(CatalogService)).toBe(true);
    }).pipe(
      Effect.provide(
        world({
          catalog: {
            features: [messages],
            tiers: [tier({ id: "free", grants: [allowance(messages, { included: 100 })] })],
          },
          guards: InsecureDevGuards,
        }),
      ),
    ),
  );

  it.live("refuses a catalog that does not decode, in the layer's error channel", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.serviceOption(CatalogService).pipe(
          Effect.provide(
            world({
              catalog: { features: [messages, messages], tiers: [] },
              guards: InsecureDevGuards,
            }),
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("CatalogDuplicateFeature");
    }),
  );

  it.live("refuses two providers that share a name, which `refs` cannot tell apart", () =>
    Effect.gen(function* () {
      const error = yield* refusalOf({
        catalog: testCatalog,
        guards: InsecureDevGuards,
        providers: [PaymentsMemory(), PaymentsMemory()],
      });

      expect(error?._tag).toBe("ProviderDuplicate");

      if (error?._tag === "ProviderDuplicate") expect(error.provider).toBe("memory");
    }),
  );

  it.live("refuses a provider price that disagrees with the catalog", () =>
    Effect.gen(function* () {
      const error = yield* refusalOf({
        catalog: pricedCatalog,
        guards: InsecureDevGuards,
        providers: [
          {
            ...PaymentsMemory(),
            prices: { pro: { amount: 2000, currency: "usd", interval: "month" as const } },
          },
        ],
      });

      expect(error?._tag).toBe("CatalogPriceMismatch");

      if (error?._tag === "CatalogPriceMismatch") {
        expect(error.tier).toBe("pro");
        expect(error.field).toBe("amount");
      }
    }),
  );

  it.live("refuses a priced tier no configured provider can sell", () =>
    Effect.gen(function* () {
      const error = yield* refusalOf({
        catalog: pricedCatalog,
        guards: InsecureDevGuards,
        providers: [{ ...PaymentsManual(), capabilities: new Set(["refund"] as const) }],
      });

      expect(error?._tag).toBe("NoPurchasePath");

      if (error?._tag === "NoPurchasePath") expect(error.tier).toBe("pro");
    }),
  );

  it.live(
    "builds a priced catalog over a pre-built money layer, whose capabilities are not declared",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.serviceOption(CatalogService).pipe(
            Effect.provide(
              world({
                catalog: pricedCatalog,
                guards: InsecureDevGuards,
                // A fake `Payments` layer is the documented test seam; the router
                // has no `MoneyProvider` to inspect, so the purchase-path rule is
                // intentionally skipped.
                payments: PaymentsMemory().payments,
              }),
            ),
          ),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
      }),
  );

  it.live("builds without guards, so a host can provide its own session", () =>
    Effect.gen(function* () {
      expect(yield* provided(Session)).toBe(false);
      // The bindings do not need a guard; the Api's middleware does, and the
      // host provides it beside this world.
      expect(yield* provided(Check)).toBe(true);
    }).pipe(Effect.provide(world({ catalog: testCatalog }))),
  );

  it.live("builds the router, and merges a single provider's payments", () =>
    Effect.gen(function* () {
      expect(yield* provided(Payments)).toBe(true);
      expect(yield* provided(Check)).toBe(true);
    }).pipe(
      Effect.provide(
        world({ catalog: testCatalog, guards: InsecureDevGuards, providers: [PaymentsMemory()] }),
      ),
    ),
  );

  it.live("serves only the operator surface when the process asks for it", () =>
    Effect.gen(function* () {
      expect(yield* provided(Check)).toBe(false);
      expect(yield* provided(GrantCredits)).toBe(true);
      expect(yield* provided(CatalogService)).toBe(true);
    }).pipe(
      Effect.provide(world({ catalog: testCatalog, guards: InsecureDevGuards, bindings: "admin" })),
    ),
  );

  it.live("leaves the provider choice to the router when two are configured", () =>
    Effect.gen(function* () {
      // Merging both layers would shadow one by merge order; the account's own
      // provider is selected from the router's refs instead.
      expect(yield* provided(Payments)).toBe(false);
      expect(yield* provided(PaymentsRouter)).toBe(true);
      expect(yield* provided(Check)).toBe(true);
    }).pipe(
      Effect.provide(
        world({
          catalog: testCatalog,
          guards: InsecureDevGuards,
          providers: [PaymentsMemory(), PaymentsManual()],
        }),
      ),
    ),
  );
});
