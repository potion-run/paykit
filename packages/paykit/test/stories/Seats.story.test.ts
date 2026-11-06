import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, tierTermsOf } from "../../src/Catalog.ts";
import { feature } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { FeatureNotConsumable } from "../../src/Subscription/FeatureNotConsumable.rejection.ts";
import {
  QuantityCapExceeded,
  QuantityChanged,
  SetQuantity,
} from "../../src/Subscription/SetQuantity.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };
const seatPrice = { kind: "unit" as const, amount: 1_000, currency: "usd" };

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

const teamTier = tier({
  id: "team",
  price,
  grants: [
    allowance(seats, {
      included: 5,
      overage: "bill",
      pricing: seatPrice,
      cap: 20,
    }),
  ],
});

const testCatalog = Effect.runSync(catalog({ features: [seats], tiers: [teamTier] }));
const terms = tierTermsOf(testCatalog, "team")!;
const account = Subscription.ref("acct_seats");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const mid = at("2030-01-16T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const subscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: terms.rates,
      tier: "team",
      allowances: terms.allowances,
      price,
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "team",
      credits: 0,
      creditsExpire: "period",
      rates: terms.rates,
      allowances: terms.allowances,
      remaining: { seats: 15 },
      periodStart: start,
      periodEnd: monthLater,
      anchorTz: "UTC",
      interval: "month",
      currency: "usd",
      price,
      statusAfter: "active",
    }),
  ),
] as const;

it.effect("a seat change prorates the billable difference for the rest of the period", () =>
  story(
    ...subscribed,
    Story.clock(mid),
    // 5 included, so adding 3 seats bills 3 × $10 for the 16 days left.
    Story.when(account, new SetQuantity({ feature: "seats", quantity: 8, dedupeKey: "seats:add" })),
    Story.then(
      account,
      new QuantityChanged({
        feature: "seats",
        quantityBefore: 5,
        quantityAfter: 8,
        proration: { currency: "usd", credit: 0, charge: 1_548, due: 1_548 },
        prorationId: "seats:add",
      }),
    ),
    // Giving 2 back credits the same fraction of 2 × $10.
    Story.when(
      account,
      new SetQuantity({ feature: "seats", quantity: 6, dedupeKey: "seats:drop" }),
    ),
    Story.then(
      account,
      new QuantityChanged({
        feature: "seats",
        quantityBefore: 8,
        quantityAfter: 6,
        proration: { currency: "usd", credit: 1_032, charge: 0, due: -1_032 },
        prorationId: "seats:drop",
      }),
    ),
    Story.view(Entitlements, account, {
      periodEnd: monthLater,
      features: {
        seats: {
          kind: "non_consumable",
          included: 5,
          used: 6,
          reserved: 0,
          remaining: 14,
          carried: 0,
          allowed: true,
          overage: "bill",
          cap: 20,
          quantity: 6,
          resets: "never",
          resetsAt: null,
        },
      },
    }),
  ),
);

it.effect("a seat is set, not tracked, and the cap refuses a quantity past it", () =>
  story(
    ...subscribed,
    Story.when(account, new TrackUsage({ feature: "seats", amount: 1 })),
    Story.rejected(new FeatureNotConsumable({ feature: "seats" })),
    Story.when(
      account,
      new SetQuantity({ feature: "seats", quantity: 21, dedupeKey: "seats:too-many" }),
    ),
    Story.rejected(new QuantityCapExceeded({ feature: "seats", cap: 20, quantity: 21 })),
  ),
);
