import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, tierTermsOf } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };

/**
 * The first 100 units at one cent each, then two cents. `included` is zero, so
 * every unit is billable and the bands are easy to see.
 */
const ladderTier = tier({
  id: "ladder",
  price,
  grants: [
    allowance(messages, {
      included: 0,
      overage: "bill",
      pricing: {
        kind: "graduated",
        currency: "usd",
        bands: [
          { upTo: 100, amount: 1, currency: "usd" },
          { upTo: "inf", amount: 2, currency: "usd" },
        ],
      },
    }),
  ],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [ladderTier] }));
const terms = tierTermsOf(testCatalog, "ladder")!;
const account = Subscription.ref("acct_ladder");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

it.effect("prices each band as usage crosses it, and the report keeps both lines", () =>
  story(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: terms.rates,
        tier: "ladder",
        allowances: terms.allowances,
        price,
      }),
    ),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: "ladder",
        credits: 0,
        creditsExpire: "period",
        rates: terms.rates,
        allowances: terms.allowances,
        remaining: { messages: 0 },
        periodStart: start,
        periodEnd: monthLater,
        anchorTz: "UTC",
        interval: "month",
        currency: "usd",
        price,
        statusAfter: "active",
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 90 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 90,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 90,
        remainingAfter: -90,
        charge: 90,
        billedAfter: 90,
        billable: 90,
        priced: [
          {
            key: "usd:1",
            unitPrice: { amount: 1, currency: "usd" },
            quantity: 90,
            amount: 90,
          },
        ],
      }),
    ),
    // 110 units cross the 100-unit boundary: the first 10 are still a cent
    // each, the last 10 are two.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 20 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 20,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 110,
        remainingAfter: -110,
        charge: 30,
        billedAfter: 120,
        billable: 20,
        priced: [
          {
            key: "usd:1",
            unitPrice: { amount: 1, currency: "usd" },
            quantity: 10,
            amount: 10,
          },
          {
            key: "usd:2",
            unitPrice: { amount: 2, currency: "usd" },
            quantity: 10,
            amount: 20,
          },
        ],
      }),
    ),
    Story.view(Entitlements, account, {
      periodEnd: monthLater,
      features: {
        messages: {
          included: 0,
          used: 110,
          reserved: 0,
          remaining: -110,
          carried: 0,
          allowed: true,
          overage: "bill",
          resets: "month",
          resetsAt: monthLater,
          billed: 120,
          priced: {
            "usd:1": { unitPrice: { amount: 1, currency: "usd" }, quantity: 100 },
            "usd:2": { unitPrice: { amount: 2, currency: "usd" }, quantity: 10 },
          },
        },
      },
    }),
  ),
);
