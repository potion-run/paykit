import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { planItemsOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { ChangeTier, PlanChanged } from "../../src/Subscription/ChangeTier.command.ts";
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { ConsumeCredits, CreditsConsumed } from "../../src/Subscription/ConsumeCredits.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import {
  CreditsPurchased,
  PurchaseCredits,
} from "../../src/Subscription/PurchaseCredits.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };
const packPrice = { amount: 9_900, currency: "usd", interval: "month" as const };

const proTier = tier({
  id: "pro",
  price,
  credits: 100,
  grants: [allowance(messages, { included: 100 })],
});

const packTier = tier({
  id: "credits_1k",
  kind: "one_off",
  price: packPrice,
  credits: 1_000,
  grants: [],
});

const nextTier = tier({
  id: "next",
  price,
  credits: 0,
  grants: [allowance(messages, { included: 200 })],
});

const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [proTier, nextTier, packTier] }),
);

const pro = planItemsOf(testCatalog, "pro")!;
const next = planItemsOf(testCatalog, "next")!;
const account = Subscription.ref("acct_prepaid");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const march = at("2030-03-01T00:00:00Z");

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

const closed = (
  periodStart: DateTime.Utc,
  periodEnd: DateTime.Utc,
  nextEnd: DateTime.Utc,
  expired: number,
  balance: number,
  remainingMessages = 100,
) =>
  [
    new PeriodClosed({
      periodStart,
      periodEnd,
      nextPeriodStart: periodEnd,
      nextPeriodEnd: nextEnd,
      statusAfter: "active",
      standingAfter: "good",
      cancelAtPeriodEndAfter: false,
    }),
    new UsageReset({ remaining: { messages: remainingMessages }, carried: { messages: 0 } }),
    new CreditsExpired({ amount: expired, balanceAfter: balance }),
  ] as const;

it.effect("buys a one-off pack, and a period close expires only the plan's credits", () =>
  story(
    ...subscribed,
    Story.when(
      account,
      new PurchaseCredits({ tier: "credits_1k", amount: 1_000, price: packPrice }),
    ),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "credits_1k",
        amount: 1_000,
        price: packPrice,
        balanceAfter: 1_100,
        prepaidAfter: 1_000,
      }),
    ),
    Story.view(Entitlements, account, { credits: 1_100 }),
    // The plan's 100 credits expire; the 1,000 bought ones do not.
    Story.clock(monthLater),
    Story.then(account, ...closed(start, monthLater, march, 100, 1_000)),
    Story.view(Entitlements, account, { credits: 1_000 }),
  ),
);

it.effect("buys a pack before a plan, and the first subscription carries the pool", () =>
  story(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new PurchaseCredits({ tier: "credits_1k", amount: 1_000, price: packPrice }),
    ),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "credits_1k",
        amount: 1_000,
        price: packPrice,
        balanceAfter: 1_000,
        prepaidAfter: 1_000,
      }),
    ),
    Story.view(Entitlements, account, { credits: 1_000 }),
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
        credits: 1_100,
        prepaidCredits: 1_000,
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
    Story.view(Entitlements, account, { credits: 1_100 }),
  ),
);

it.effect("a tier change carries the pack instead of re-granting it", () =>
  story(
    ...subscribed,
    Story.when(
      account,
      new PurchaseCredits({ tier: "credits_1k", amount: 1_000, price: packPrice }),
    ),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "credits_1k",
        amount: 1_000,
        price: packPrice,
        balanceAfter: 1_100,
        prepaidAfter: 1_000,
      }),
    ),
    Story.when(
      account,
      new ChangeTier({
        tier: "next",
        allowances: next,
        price,
        credits: 0,
        creditsExpire: "period",
        rates: {},
        // Same price on both sides, so the change owes nothing.
        proration: { currency: "usd", credit: 1900, charge: 1900, due: 0 },
      }),
    ),
    Story.then(
      account,
      new PlanChanged({
        tier: "next",
        allowances: next,
        remaining: { messages: 200 },
        credits: 1_100,
        prepaidCredits: 1_000,
        creditsExpire: "period",
        rates: {},
        currency: "usd",
        interval: "month",
        priceBefore: price,
        priceAfter: price,
        proration: { currency: "usd", credit: 1900, charge: 1900, due: 0 },
      }),
    ),
    Story.clock(monthLater),
    Story.then(account, ...closed(start, monthLater, march, 100, 1_000, 200)),
    Story.view(Entitlements, account, { credits: 1_000, tier: "next" }),
  ),
);

it.effect("spending the plan's credits first leaves the pack protected at the next close", () =>
  story(
    ...subscribed,
    Story.when(
      account,
      new PurchaseCredits({ tier: "credits_1k", amount: 1_000, price: packPrice }),
    ),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "credits_1k",
        amount: 1_000,
        price: packPrice,
        balanceAfter: 1_100,
        prepaidAfter: 1_000,
      }),
    ),
    // 200 of the 1,100 is spent. The plan's 100 goes first, then 100 of the
    // pack, leaving 900 protected out of a 900 balance.
    Story.when(account, new ConsumeCredits({ amount: 200 })),
    Story.then(account, new CreditsConsumed({ amount: 200, balanceAfter: 900 })),
    Story.clock(monthLater),
    Story.then(account, ...closed(start, monthLater, march, 0, 900)),
    Story.view(Entitlements, account, { credits: 900 }),
  ),
);
