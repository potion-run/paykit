import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { ChargeQuantityProration } from "../../src/Billing/ChargeQuantityProration.binding.ts";
import { SetQuantity } from "../../src/Billing/SetQuantity.binding.ts";
import { catalog, tierTermsOf } from "../../src/Catalog.ts";
import { feature } from "../../src/Feature.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { bindingsWorld } from "../support/Bindings.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };
const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });
const teamTier = tier({
  id: "team",
  price,
  grants: [
    allowance(seats, {
      included: 5,
      overage: "bill",
      pricing: { kind: "unit", amount: 1_000, currency: "usd" },
      cap: 20,
    }),
  ],
});
const testCatalog = Effect.runSync(catalog({ features: [seats], tiers: [teamTier] }));
const terms = tierTermsOf(testCatalog, "team")!;
const account = "acct_seat_charge";
const memory = PaymentsMemory();

const World = bindingsWorld({
  catalog: testCatalog,
  payments: memory.payments,
  guards: Layer.succeed(Actor, system("test")),
});

const subscribed = Effect.gen(function* () {
  const subscription = yield* Subscription;
  const ref = Subscription.ref(account);
  yield* subscription.send(
    ref,
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: terms.rates,
      tier: "team",
      allowances: terms.allowances,
      price,
    }),
  );
});

describe("charging a seat change", () => {
  it.live("opens one invoice for the prorated difference, then nothing", () =>
    Effect.gen(function* () {
      yield* subscribed;
      const set = yield* SetQuantity(account);
      const changed = yield* set({ feature: "seats", quantity: 8, dedupeKey: "seats:add" });
      // At the start of the period the whole 3 × $10 is unused.
      expect(changed.quantity).toBe(8);
      expect(changed.proration?.due).toBe(3_000);

      const charge = yield* ChargeQuantityProration(account);
      const first = yield* charge({ prorationId: "seats:add" });
      expect(first).toEqual({
        outcome: "charged",
        invoiceId: "in_1",
        amount: 3_000,
        currency: "usd",
      });
      // The invoice is recorded on the standing, so a retry collects nothing.
      expect(yield* charge({ prorationId: "seats:add" })).toEqual({ outcome: "nothing" });
    }).pipe(Effect.provide(World)),
  );

  it.live("a reduction records a credit and never opens an invoice", () =>
    Effect.gen(function* () {
      yield* subscribed;
      const set = yield* SetQuantity(account);
      yield* set({ feature: "seats", quantity: 8, dedupeKey: "seats:add" });
      const dropped = yield* set({ feature: "seats", quantity: 6, dedupeKey: "seats:drop" });
      expect(dropped.proration?.due).toBe(-2_000);

      const charge = yield* ChargeQuantityProration(account);
      expect(yield* charge({ prorationId: "seats:drop" })).toEqual({ outcome: "nothing" });
    }).pipe(Effect.provide(World)),
  );
});
