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
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Hold, UsageReserved } from "../../src/Subscription/Hold.command.ts";
import { SettleHold, UsageSettled } from "../../src/Subscription/SettleHold.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  MoneyCapExceeded,
  TrackUsage,
  UsageRecorded,
} from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };
const unitPrice = { amount: 2, currency: "usd" } as const;

const meteredTier = tier({
  id: "metered",
  price,
  grants: [
    allowance(messages, {
      included: 100,
      overage: "bill",
      unitPrice,
      moneyCap: 500,
    }),
  ],
});
const paygoTier = tier({
  id: "paygo",
  grants: [
    allowance(messages, {
      included: 0,
      overage: "bill",
      unitPrice: { amount: 5, currency: "usd" },
    }),
  ],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [meteredTier, paygoTier] }),
);
const metered = allowancesOf(testCatalog, "metered")!;
const paygo = allowancesOf(testCatalog, "paygo")!;
const account = Subscription.ref("acct_postpaid");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const quarter = at("2030-01-01T00:15:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const march = at("2030-03-01T00:00:00Z");

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const feature = (over: {
  readonly used: number;
  readonly remaining: number;
  readonly billed: number;
  readonly resetsAt?: DateTime.Utc;
}) => ({
  included: 100,
  used: over.used,
  reserved: 0,
  remaining: over.remaining,
  carried: 0,
  allowed: over.billed + unitPrice.amount <= 500,
  overage: "bill" as const,
  resets: "month" as const,
  resetsAt: over.resetsAt ?? monthLater,
  unitPrice,
  moneyCap: 500,
  // `billed` is absent when nothing has been billed this period, the same way
  // a fresh standing reports it: zero is the absence of a bill, not a number.
  ...(over.billed === 0 ? {} : { billed: over.billed }),
});

const subscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      tier: "metered",
      allowances: metered,
      price,
      credits: 0,
      creditsExpire: "period",
      rates: {},
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "metered",
      allowances: metered,
      remaining: { messages: 100 },
      credits: 0,
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

it.effect("a free tier can be postpaid, and derives its currency from the unit price", () =>
  story(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        tier: "paygo",
        allowances: paygo,
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
    ),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: "paygo",
        allowances: paygo,
        remaining: { messages: 0 },
        credits: 0,
        creditsExpire: "period",
        rates: {},
        periodStart: start,
        periodEnd: monthLater,
        anchorTz: "UTC",
        interval: "month",
        currency: "usd",
        statusAfter: "active",
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 2 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 2,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 2,
        remainingAfter: -2,
        charge: 10,
        billedAfter: 10,
        unitPrice: { amount: 5, currency: "usd" },
        billable: 2,
      }),
    ),
    Story.view(Entitlements, account, {
      features: {
        messages: {
          included: 0,
          used: 2,
          reserved: 0,
          remaining: -2,
          carried: 0,
          allowed: true,
          overage: "bill",
          resets: "month",
          resetsAt: monthLater,
          unitPrice: { amount: 5, currency: "usd" },
          billed: 10,
        },
      },
    }),
  ),
);

it.effect("prices the billable part of usage, and refuses at a money cap", () =>
  story(
    ...subscribed,
    // The included 100 bills nothing.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 100,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 100,
        remainingAfter: 0,
        charge: 0,
        billedAfter: 0,
        unitPrice,
        billable: 0,
      }),
    ),
    // The next 50 are past the included count: 50 × 2 minor units.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 50 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 50,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 150,
        remainingAfter: -50,
        charge: 100,
        billedAfter: 100,
        unitPrice,
        billable: 50,
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 100,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 250,
        remainingAfter: -150,
        charge: 200,
        billedAfter: 300,
        unitPrice,
        billable: 100,
      }),
    ),
    // Exactly at the 500 money cap.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 100,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 350,
        remainingAfter: -250,
        charge: 200,
        billedAfter: 500,
        unitPrice,
        billable: 100,
      }),
    ),
    Story.view(Entitlements, account, {
      features: { messages: feature({ used: 350, remaining: -250, billed: 500 }) },
    }),
    // One more unit would be 502 > 500.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 1 })),
    Story.rejected(new MoneyCapExceeded({ feature: "messages", cap: 500, billed: 500, charge: 2 })),
  ),
);

it.effect("a settled hold bills the money for what ran, at the same unit price", () =>
  story(
    ...subscribed,
    Story.when(account, new TrackUsage({ feature: "messages", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 100,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 100,
        remainingAfter: 0,
        charge: 0,
        billedAfter: 0,
        unitPrice,
        billable: 0,
      }),
    ),
    Story.when(account, new Hold({ holdId: "hold_postpaid", feature: "messages", amount: 50 })),
    Story.then(
      account,
      new UsageReserved({
        holdId: "hold_postpaid",
        feature: "messages",
        amount: 50,
        rate: 0,
        cost: 0,
        at: start,
        expiresAt: quarter,
        remainingAfter: -50,
      }),
    ),
    // 40 ran: 40 × 2 = 80, and the other 10 returns in the same command.
    Story.when(account, new SettleHold({ holdId: "hold_postpaid", amount: 40 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 40,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 140,
        remainingAfter: -40,
        charge: 80,
        billedAfter: 80,
        unitPrice,
        billable: 40,
      }),
      new UsageSettled({
        holdId: "hold_postpaid",
        feature: "messages",
        amount: 40,
        released: 10,
        cost: 0,
        remainingAfter: -40,
      }),
    ),
  ),
);

it.effect("resets the period's billed money at the close, and bills again next period", () =>
  story(
    ...subscribed,
    Story.when(account, new TrackUsage({ feature: "messages", amount: 150 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 150,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 150,
        remainingAfter: -50,
        charge: 100,
        billedAfter: 100,
        unitPrice,
        billable: 50,
      }),
    ),
    Story.clock(monthLater),
    Story.then(
      account,
      new PeriodClosed({
        periodStart: start,
        periodEnd: monthLater,
        nextPeriodStart: monthLater,
        nextPeriodEnd: march,
        statusAfter: "active",
        standingAfter: "good",
        cancelAtPeriodEndAfter: false,
      }),
      new UsageReset({ remaining: { messages: 100 }, carried: { messages: 0 } }),
      new CreditsExpired({ amount: 0, balanceAfter: 0 }),
    ),
    Story.view(Entitlements, account, {
      features: { messages: feature({ used: 0, remaining: 100, billed: 0, resetsAt: march }) },
    }),
    // A new period starts with no billed money and the same unit price.
    Story.when(account, new TrackUsage({ feature: "messages", amount: 50 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 50,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 50,
        remainingAfter: 50,
        charge: 0,
        billedAfter: 0,
        unitPrice,
        billable: 0,
      }),
    ),
  ),
);
