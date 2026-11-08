import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import {
  CreditsPurchased,
  PurchaseCredits,
} from "../../src/Subscription/PurchaseCredits.command.ts";
import {
  Refund,
  RefundExceedsCharged,
  RefundRecorded,
} from "../../src/Subscription/Refund.command.ts";
import {
  RefundNotFound,
  RefundReversed,
  RefundReversalExceedsRefunded,
  ReverseRefund,
} from "../../src/Subscription/ReverseRefund.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };
const packPrice = { amount: 4_900, currency: "usd", interval: "month" as const };

const proTier = tier({
  id: "pro",
  price,
  credits: 100,
  grants: [allowance(messages, { included: 100 })],
});

const packTier = tier({
  id: "credits_5k",
  kind: "one_off",
  price: packPrice,
  credits: 5_000,
  grants: [],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier, packTier] }));
const pro = allowancesOf(testCatalog, "pro")!;
const account = Subscription.ref("acct_refund");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
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
      tier: "pro",
      allowances: pro,
      price,
      credits: 100,
      creditsExpire: "period",
      rates: {},
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "pro",
      allowances: pro,
      remaining: { messages: 100 },
      credits: 100,
      creditsExpire: "period",
      rates: {},
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

/** A bought pack is money charged, which is what a refund is measured against. */
const bought = [
  Story.when(
    account,
    new PurchaseCredits({ tier: "credits_5k", amount: 5_000, price: packPrice, rates: {} }),
  ),
  Story.then(
    account,
    new CreditsPurchased({
      tier: "credits_5k",
      amount: 5_000,
      price: packPrice,
      rates: {},
      balanceAfter: 5_100,
      prepaidAfter: 5_000,
    }),
  ),
] as const;

it.effect("records money going back, and leaves the pool alone", () =>
  story(
    ...subscribed,
    ...bought,
    Story.when(
      account,
      new Refund({
        chargeId: "ch_1",
        refundId: "re_1",
        amount: 4_900,
        currency: "usd",
        reason: "duplicate order",
      }),
    ),
    Story.then(
      account,
      new RefundRecorded({
        chargeId: "ch_1",
        refundId: "re_1",
        amount: 4_900,
        currency: "usd",
        reason: "duplicate order",
        commandId: "story:7",
        refundedAfter: 4_900,
      }),
    ),
    // The page can say what was charged and what went back, per currency.
    Story.view(BillingState, account, {
      charged: { usd: 4_900 },
      refunded: { usd: 4_900 },
    }),
    // A refund does not revoke the credits the pack bought: that is
    // `ConsumeCredits`, a separate operator call (ADR 0019).
    Story.view(Entitlements, account, { credits: 5_100 }),
  ),
);

it.effect("a refund past what the account was charged is refused, and records nothing", () =>
  story(
    ...subscribed,
    ...bought,
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_1", amount: 4_000, currency: "usd" }),
    ),
    Story.then(
      account,
      new RefundRecorded({
        chargeId: "ch_1",
        refundId: "re_1",
        amount: 4_000,
        currency: "usd",
        commandId: "story:7",
        refundedAfter: 4_000,
      }),
    ),
    // 4,000 of 4,900 has gone back: 900 is left, so 901 is too much.
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_2", amount: 901, currency: "usd" }),
    ),
    Story.rejected(
      new RefundExceedsCharged({
        currency: "usd",
        charged: 4_900,
        refunded: 4_000,
        requested: 901,
      }),
    ),
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_2", amount: 900, currency: "usd" }),
    ),
    Story.then(
      account,
      new RefundRecorded({
        chargeId: "ch_1",
        refundId: "re_2",
        amount: 900,
        currency: "usd",
        commandId: "story:11",
        refundedAfter: 4_900,
      }),
    ),
    Story.view(BillingState, account, {
      charged: { usd: 4_900 },
      refunded: { usd: 4_900 },
    }),
  ),
);

it.effect("counts money per currency, so a currency nothing was charged in refunds nothing", () =>
  story(
    ...subscribed,
    ...bought,
    // The pack was charged in dollars; a euro refund has no ceiling to spend.
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_1", amount: 100, currency: "eur" }),
    ),
    Story.rejected(
      new RefundExceedsCharged({
        currency: "eur",
        charged: 0,
        refunded: 0,
        requested: 100,
      }),
    ),
    Story.view(BillingState, account, { charged: { usd: 4_900 } }),
  ),
);

it.effect("records nothing for a non-positive refund", () =>
  story(
    ...subscribed,
    ...bought,
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_1", amount: 0, currency: "usd" }),
    ),
    Story.view(BillingState, account, { charged: { usd: 4_900 } }),
  ),
);

it.effect("a reversal puts the headroom back, so the money owed can still go back", () =>
  story(
    ...subscribed,
    ...bought,
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_1", amount: 4_900, currency: "usd" }),
    ),
    Story.then(
      account,
      new RefundRecorded({
        chargeId: "ch_1",
        refundId: "re_1",
        amount: 4_900,
        currency: "usd",
        commandId: "story:7",
        refundedAfter: 4_900,
      }),
    ),
    // The provider reverses it: the money never left, and the page that says
    // 4,900 went back is now wrong (ADR 0027).
    Story.when(
      account,
      new ReverseRefund({ refundId: "re_1", amount: 4_900, reason: "ach_return" }),
    ),
    Story.then(
      account,
      new RefundReversed({
        refundId: "re_1",
        amount: 4_900,
        currency: "usd",
        refundedAfter: 0,
        reason: "ach_return",
        commandId: "story:9",
      }),
    ),
    Story.view(BillingState, account, {
      charged: { usd: 4_900 },
      refunded: { usd: 0 },
      // The row keeps its place and records what came back, which is what a
      // console reads to offer a reversal (ADR 0030).
      refunds: {
        re_1: { refundId: "re_1", amount: 4_900, currency: "usd", reversed: 4_900 },
      },
    }),
    // The ceiling is the truth again, so the same charge can go back properly.
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_2", amount: 4_900, currency: "usd" }),
    ),
    Story.then(
      account,
      new RefundRecorded({
        chargeId: "ch_1",
        refundId: "re_2",
        amount: 4_900,
        currency: "usd",
        commandId: "story:12",
        refundedAfter: 4_900,
      }),
    ),
    // Money moved twice; the credits the pack bought are still the account's.
    Story.view(Entitlements, account, { credits: 5_100 }),
  ),
);

it.effect("a reversal larger than the refund it names is refused", () =>
  story(
    ...subscribed,
    ...bought,
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_1", amount: 4_000, currency: "usd" }),
    ),
    Story.then(
      account,
      new RefundRecorded({
        chargeId: "ch_1",
        refundId: "re_1",
        amount: 4_000,
        currency: "usd",
        commandId: "story:7",
        refundedAfter: 4_000,
      }),
    ),
    Story.when(account, new ReverseRefund({ refundId: "re_1", amount: 4_001 })),
    Story.rejected(
      new RefundReversalExceedsRefunded({
        refundId: "re_1",
        refunded: 4_000,
        reversed: 0,
        requested: 4_001,
      }),
    ),
  ),
);

it.effect("a reversal of a refund the log does not hold is refused", () =>
  story(
    ...subscribed,
    ...bought,
    Story.when(account, new ReverseRefund({ refundId: "re_missing", amount: 100 })),
    Story.rejected(new RefundNotFound({ refundId: "re_missing" })),
  ),
);

it.effect("reverses a refund in two parts, and refuses a third", () =>
  story(
    ...subscribed,
    ...bought,
    Story.when(
      account,
      new Refund({ chargeId: "ch_1", refundId: "re_1", amount: 1_000, currency: "usd" }),
    ),
    Story.then(
      account,
      new RefundRecorded({
        chargeId: "ch_1",
        refundId: "re_1",
        amount: 1_000,
        currency: "usd",
        commandId: "story:7",
        refundedAfter: 1_000,
      }),
    ),
    Story.when(account, new ReverseRefund({ refundId: "re_1", amount: 400 })),
    Story.then(
      account,
      new RefundReversed({
        refundId: "re_1",
        amount: 400,
        currency: "usd",
        refundedAfter: 600,
        commandId: "story:9",
      }),
    ),
    Story.when(account, new ReverseRefund({ refundId: "re_1", amount: 600 })),
    Story.then(
      account,
      new RefundReversed({
        refundId: "re_1",
        amount: 600,
        currency: "usd",
        refundedAfter: 0,
        commandId: "story:11",
      }),
    ),
    // All 1,000 is back, so there is nothing left of this refund to reverse.
    Story.when(account, new ReverseRefund({ refundId: "re_1", amount: 1 })),
    Story.rejected(
      new RefundReversalExceedsRefunded({
        refundId: "re_1",
        refunded: 1_000,
        reversed: 1_000,
        requested: 1,
      }),
    ),
  ),
);
