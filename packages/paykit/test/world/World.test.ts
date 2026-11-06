import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { DevGuards } from "../../src/Auth/FromHeaders.ts";
import { Session } from "../../src/Auth/Guards.ts";
import { GrantCredits } from "../../src/Billing/Admin.binding.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { BillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogService } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { Payments } from "../../src/Payments.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { tier } from "../../src/Tier.ts";
import { paykitWorld } from "../../src/World.ts";

const testCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [tier({ id: "free", grants: [allowance(messages, { included: 100 })] })],
  }),
);

/** Is this service in the context the world built? */
const provided = <A extends { readonly key: string }>(tag: A) =>
  Effect.gen(function* () {
    const held = yield* Effect.serviceOption(tag as never);
    return Option.isSome(held);
  });

describe("paykitWorld", () => {
  it.live("provides the tenant bindings, the catalog, the store and the guards", () =>
    Effect.gen(function* () {
      expect(yield* provided(Check)).toBe(true);
      expect(yield* provided(CatalogService)).toBe(true);
      expect(yield* provided(BillingReadStore)).toBe(true);
      expect(yield* provided(Session)).toBe(true);
      expect(yield* provided(GrantCredits)).toBe(false);
    }).pipe(Effect.provide(paykitWorld({ catalog: testCatalog, guards: DevGuards }))),
  );

  it.live("adds the operator bindings when the process serves them", () =>
    Effect.gen(function* () {
      expect(yield* provided(Check)).toBe(true);
      expect(yield* provided(GrantCredits)).toBe(true);
    }).pipe(
      Effect.provide(paykitWorld({ catalog: testCatalog, guards: DevGuards, bindings: "both" })),
    ),
  );

  it.live("serves no binding when the process only hosts the model", () =>
    Effect.gen(function* () {
      expect(yield* provided(Check)).toBe(false);
      expect(yield* provided(GrantCredits)).toBe(false);
      expect(yield* provided(CatalogService)).toBe(true);
    }).pipe(
      Effect.provide(paykitWorld({ catalog: testCatalog, guards: DevGuards, bindings: "none" })),
    ),
  );

  it.live("builds without guards, so a host can provide its own session", () =>
    Effect.gen(function* () {
      expect(yield* provided(Session)).toBe(false);
      // The bindings do not need a guard; the Api's middleware does, and the
      // host provides it beside this world.
      expect(yield* provided(Check)).toBe(true);
    }).pipe(Effect.provide(paykitWorld({ catalog: testCatalog }))),
  );

  it.live("builds the router, and merges a single provider's payments", () =>
    Effect.gen(function* () {
      expect(yield* provided(Payments)).toBe(true);
      expect(yield* provided(Check)).toBe(true);
    }).pipe(
      Effect.provide(
        paykitWorld({ catalog: testCatalog, guards: DevGuards, providers: [PaymentsMemory()] }),
      ),
    ),
  );
});
