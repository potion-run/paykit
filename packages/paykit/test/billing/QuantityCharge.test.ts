import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { allowance } from "../../src/Allowance.ts";
import { asSystem } from "../../src/Auth/Actor.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { ChargeQuantityProration } from "../../src/Billing/ChargeQuantityProration.binding.ts";
import { SetQuantity } from "../../src/Billing/SetQuantity.binding.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { feature } from "../../src/Feature.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { AttachProviderRef } from "../../src/Subscription/AttachProviderRef.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { world } from "../../src/World.ts";

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
const terms = planTermsOf(testCatalog, "team")!;
const account = "acct_seat_charge";

const subscribed = (provider: string) =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const ref = Subscription.ref(account);
    yield* asSystem(
      subscription.send(
        ref,
        new Subscribe({
          credits: 0,
          creditsExpire: "period",
          rates: terms.rates,
          tier: "team",
          allowances: terms.allowances,
          price,
        }),
      ),
    );
    yield* asSystem(
      subscription.send(
        ref,
        new AttachProviderRef({
          provider,
          refs: { customer: "cus_1", subscription: "sub_1" },
        }),
      ),
    );
  });

const worldOf = (providers: Parameters<typeof world>[0]["providers"]) =>
  world({
    catalog: testCatalog,
    providers,
    guards: InsecureDevGuards,
    bindings: "tenant",
  });

describe("a vendor that owns the subscription quantity", () => {
  it.live("is told the new total and records the invoice it opened", () => {
    const memory = PaymentsMemory();

    return Effect.gen(function* () {
      yield* subscribed("memory");
      const set = yield* SetQuantity(account);
      const changed = yield* set({ feature: "seats", quantity: 8, dedupeKey: "seats:add" });
      expect(changed.quantity).toBe(8);
      expect(changed.proration?.due).toBe(3_000);

      // The vendor saw the total, not a delta, and the change's key.
      expect(memory.quantities).toEqual([
        {
          account,
          subscription: "sub_1",
          tier: "team",
          feature: "seats",
          quantity: 8,
          proration: "immediate",
          commandId: "seats:add",
        },
      ]);

      // The vendor opened the invoice, so the local collector has nothing to do.
      const charge = yield* ChargeQuantityProration(account);
      expect(yield* charge({ prorationId: "seats:add" })).toEqual({ outcome: "nothing" });
    }).pipe(Effect.provide(worldOf([memory])));
  });

  it.live("answers the quantity it left in place when the change writes nothing", () => {
    const memory = PaymentsMemory();

    return Effect.gen(function* () {
      yield* subscribed("memory");
      const set = yield* SetQuantity(account);
      // The account starts with the 5 free seats. Setting them again is a no-op
      // decision, and the reply still answers what the account holds.
      const same = yield* set({ feature: "seats", quantity: 5, dedupeKey: "seats:same" });
      expect(same).toEqual({ quantity: 5 });
      // The vendor is still told the total, under the caller's key.
      expect(memory.quantities).toHaveLength(1);
      expect(memory.quantities[0]?.commandId).toBe("seats:same");
    }).pipe(Effect.provide(worldOf([memory])));
  });
});

describe("a vendor without the quantity capability", () => {
  it.live("leaves the proration for the local collector", () => {
    const manual = PaymentsManual();

    return Effect.gen(function* () {
      yield* subscribed("manual");
      const set = yield* SetQuantity(account);
      const changed = yield* set({ feature: "seats", quantity: 8, dedupeKey: "seats:add" });
      expect(changed.proration?.due).toBe(3_000);

      const charge = yield* ChargeQuantityProration(account);
      expect(yield* charge({ prorationId: "seats:add" })).toEqual({
        outcome: "charged",
        invoiceId: "manual_invoice_1",
        amount: 3_000,
        currency: "usd",
      });
    }).pipe(Effect.provide(worldOf([manual])));
  });

  it.live("spends a reduction's credit on the next seat bill", () => {
    const manual = PaymentsManual();

    return Effect.gen(function* () {
      yield* subscribed("manual");
      const set = yield* SetQuantity(account);

      yield* set({ feature: "seats", quantity: 10, dedupeKey: "seats:ten" });
      const drop = yield* set({ feature: "seats", quantity: 1, dedupeKey: "seats:drop" });
      const credit = Math.abs(drop.proration?.due ?? 0);
      const raise = yield* set({ feature: "seats", quantity: 15, dedupeKey: "seats:fifteen" });
      const gross = raise.proration?.due ?? 0;

      expect(credit).toBeGreaterThan(0);
      expect(gross).toBeGreaterThan(credit);

      const charge = yield* ChargeQuantityProration(account);
      const result = yield* charge({ prorationId: "seats:fifteen" });

      // The invoice opens for the net; the credit is recorded on the charge.
      expect(result.outcome).toBe("charged");
      expect(result.amount).toBe(gross - credit);
      expect(result.creditApplied).toBe(credit);

      // A retry is the same invoice, not a second application.
      expect(yield* charge({ prorationId: "seats:fifteen" })).toEqual({ outcome: "nothing" });

      const subscription = yield* Subscription;
      const state = yield* subscription.state(Subscription.ref(account));

      if (state._tag === "Subscribed") {
        expect(state.quantityProrations?.["seats:drop"]?.creditApplied).toBe(credit);
        expect(state.quantityProrations?.["seats:fifteen"]?.proration.due).toBe(gross - credit);
        expect(state.quantityProrations?.["seats:fifteen"]?.proration.credit).toBe(credit);
        expect(state.charged).toEqual({ usd: gross - credit });
      }
    }).pipe(Effect.provide(worldOf([manual])));
  });

  it.live("records a credit that covers the charge and opens no invoice", () => {
    const manual = PaymentsManual();

    return Effect.gen(function* () {
      yield* subscribed("manual");
      const set = yield* SetQuantity(account);

      yield* set({ feature: "seats", quantity: 10, dedupeKey: "seats:ten" });
      yield* set({ feature: "seats", quantity: 1, dedupeKey: "seats:drop" });
      const raise = yield* set({ feature: "seats", quantity: 6, dedupeKey: "seats:six" });
      const gross = raise.proration?.due ?? 0;

      const charge = yield* ChargeQuantityProration(account);

      expect(yield* charge({ prorationId: "seats:six" })).toEqual({
        outcome: "nothing",
        creditApplied: gross,
        currency: "usd",
      });

      // No invoice exists for a fully covered charge, and the credit is spent.
      expect(yield* charge({ prorationId: "seats:six" })).toEqual({ outcome: "nothing" });
    }).pipe(Effect.provide(worldOf([manual])));
  });
});
