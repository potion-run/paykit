import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { asSystem } from "../../src/Auth/Actor.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { ChargeQuantityProration } from "../../src/Billing/ChargeQuantityProration.binding.ts";
import { SetQuantity } from "../../src/Billing/SetQuantity.binding.ts";
import { catalog, tierTermsOf } from "../../src/Catalog.ts";
import { feature } from "../../src/Feature.ts";
import type { MoneyProvider } from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { AttachProviderRef } from "../../src/Subscription/AttachProviderRef.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { world } from "../../src/World.ts";
import { assertProperty } from "../support/Property.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };
const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

const team = tier({
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

/** The same seat, billed at the period boundary rather than on the change. */
const deferred = tier({
  id: "deferred",
  price,
  grants: [
    allowance(seats, {
      included: 2,
      overage: "bill",
      pricing: { kind: "unit", amount: 2_000, currency: "usd" },
      prorate: "period_end",
      cap: 15,
    }),
  ],
});

const providerCatalog = Effect.runSync(catalog({ features: [seats], tiers: [team, deferred] }));

const Stock = Schema.Literals(["team", "deferred"]);
type Stock = typeof Stock.Type;

const termsOf = (tierId: Stock) => {
  const terms = tierTermsOf(providerCatalog, tierId);
  if (terms === null) throw new Error(`the seat catalog is missing ${tierId}`);
  return terms;
};

const account = "acct_provider";
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const open = (tierId: Stock, provider: string) =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const ref = Subscription.ref(account);
    yield* asSystem(subscription.send(ref, new Subscribe({ tier: tierId, ...termsOf(tierId) })));
    yield* asSystem(
      subscription.send(
        ref,
        new AttachProviderRef({
          provider,
          refs: { customer: "cus_provider", subscription: "sub_provider" },
        }),
      ),
    );
  });

const worldOf = (provider: MoneyProvider) =>
  world({
    catalog: providerCatalog,
    providers: [provider],
    guards: InsecureDevGuards,
    bindings: "tenant",
  });

describe("a provider that owns the subscription quantity", () => {
  const Case = Schema.Struct({
    tier: Stock,
    quantity: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 15 }))),
    key: Schema.Literals(["seats:one", "seats:two"]),
  });

  /**
   * The vendor is told the total the account should hold, the tier and feature
   * the seat belongs to, whether the difference is immediate or deferred, and
   * the caller's key — never a delta. The local proration is still the record;
   * the invoice the vendor opens is recorded on it, so the local collector has
   * nothing left to charge. A retry is the same command: one vendor change, the
   * same reply, and the first invoice.
   */
  it.live("tells the vendor the total, the mode and the key exactly once", () =>
    assertProperty(
      Arbitrary.schema(Case),
      (input) => {
        const memory = PaymentsMemory();
        return Effect.gen(function* () {
          yield* open(input.tier, "memory");
          const subscription = yield* Subscription;
          const ref = Subscription.ref(account);
          const set = yield* SetQuantity(account);
          const first = yield* set({
            feature: "seats",
            quantity: input.quantity,
            dedupeKey: input.key,
          });
          const retry = yield* set({
            feature: "seats",
            quantity: input.quantity,
            dedupeKey: input.key,
          });
          const state = yield* subscription.state(ref);
          const charge = yield* ChargeQuantityProration(account);
          const collected = yield* charge({ prorationId: input.key });

          // A no-op answer is the quantity the account holds, not zero.
          if (first.quantity !== input.quantity) return false;
          if (retry.quantity !== input.quantity) return false;
          if (!same(first.proration, retry.proration)) return false;
          if (memory.quantities.length !== 1) return false;

          const seen = memory.quantities[0]!;
          const mode =
            termsOf(input.tier).allowances.seats!.prorate === "period_end" ? "none" : "immediate";
          if (seen.account !== account) return false;
          if (seen.subscription !== "sub_provider") return false;
          if (seen.tier !== input.tier || seen.feature !== "seats") return false;
          if (seen.quantity !== input.quantity) return false;
          if (seen.proration !== mode) return false;
          if (seen.commandId !== input.key) return false;

          if (state._tag !== "Subscribed") return false;
          const entry = state.quantityProrations?.[input.key];
          if (first.proration === undefined) {
            // Nothing moved money, or the change is billed at the boundary.
            if (entry !== undefined) return false;
          } else {
            if (entry === undefined) return false;
            if (!same(entry.proration, first.proration)) return false;
            // The vendor opened the invoice, so the entry says it is billed.
            if (entry.invoiceId === undefined) return false;
          }
          // The collector only collects a positive due it still owns.
          return collected.outcome === "nothing";
        }).pipe(Effect.provide(worldOf(memory)));
      },
      { runs: 40, size: 20 },
    ),
  );

  const Billable = Schema.Struct({
    quantity: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 6, maximum: 20 }))),
  });

  /**
   * A provider without the quantity capability owns no subscription item to
   * update, so the local proration stays open and `ChargeQuantityProration`
   * collects it exactly once.
   */
  it.live("leaves the proration for the local collector when the provider cannot set it", () =>
    assertProperty(
      Arbitrary.schema(Billable),
      (input) => {
        const manual = PaymentsManual();
        return Effect.gen(function* () {
          yield* open("team", "manual");
          const subscription = yield* Subscription;
          const set = yield* SetQuantity(account);
          const changed = yield* set({
            feature: "seats",
            quantity: input.quantity,
            dedupeKey: "seats:local",
          });
          const state = yield* subscription.state(Subscription.ref(account));
          if (state._tag !== "Subscribed") return false;
          const entry = state.quantityProrations?.["seats:local"];
          if (changed.proration === undefined || entry === undefined) return false;
          if (changed.proration.due <= 0) return false;
          if (entry.invoiceId !== undefined) return false;
          if (!same(entry.proration, changed.proration)) return false;

          const charge = yield* ChargeQuantityProration(account);
          const first = yield* charge({ prorationId: "seats:local" });
          const second = yield* charge({ prorationId: "seats:local" });
          if (first.outcome !== "charged") return false;
          if (first.amount !== changed.proration.due) return false;
          if (first.currency !== changed.proration.currency) return false;
          return second.outcome === "nothing";
        }).pipe(Effect.provide(worldOf(manual)));
      },
      { runs: 30, size: 20 },
    ),
  );
});
