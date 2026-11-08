import { Story } from "@alchemy.run/domain/Story";
import { it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog, creditTermsOf } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { SubscriptionExpired } from "../../src/Subscription/Expire.command.ts";
import { ExtendTrial, TrialExtended } from "../../src/Subscription/ExtendTrial.command.ts";
import { Hold, UsageReserved } from "../../src/Subscription/Hold.command.ts";
import { PaymentRecorded, RecordPayment } from "../../src/Subscription/RecordPayment.command.ts";
import {
  PaymentFailed,
  RecordPaymentFailure,
} from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { UsageReleased } from "../../src/Subscription/ReleaseHold.command.ts";
import { SettleHold, UsageSettled } from "../../src/Subscription/SettleHold.command.ts";
import { StartTrial, TrialStarted } from "../../src/Subscription/StartTrial.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });

const creditsTier = tier({
  id: "credits",
  price: { amount: 1900, currency: "usd", interval: "month" },
  credits: 50_000,
  grants: [allowance(messages, { included: 100 })],
});

const testCatalog = Effect.runSync(
  catalog({ features: [ai, messages], tiers: [proTier, creditsTier] }),
);

const pro = allowancesOf(testCatalog, "pro")!;
const creditsTerms = creditTermsOf(testCatalog, "credits")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const annualPrice = { amount: 19_000, currency: "usd", interval: "annual" as const };

const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});

const account = Subscription.ref("acct_schedule");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const quarter = at("2030-01-01T00:15:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const march = at("2030-03-01T00:00:00Z");

const activated = new SubscriptionActivated({
  tier: "pro",
  credits: 0,
  creditsExpire: "period",
  rates: {},
  allowances: pro,
  remaining: { messages: 2000 },
  periodStart: start,
  periodEnd: monthLater,
  anchorTz: "UTC",
  interval: "month",
  currency: "usd",
  price: proPrice,
  statusAfter: "active",
});

const creditsAllowances = allowancesOf(testCatalog, "credits")!;

const creditsActivated = new SubscriptionActivated({
  tier: "credits",
  allowances: creditsAllowances,
  remaining: { messages: 100 },
  credits: creditsTerms.credits,
  creditsExpire: creditsTerms.creditsExpire,
  rates: creditsTerms.rates,
  periodStart: start,
  periodEnd: monthLater,
  anchorTz: "UTC",
  interval: "month",
  currency: "usd",
  price: proPrice,
  statusAfter: "active",
});

const messagesFeature = (over: {
  readonly used?: number;
  readonly reserved?: number;
  readonly remaining: number;
}) => ({
  included: 2_000,
  used: over.used ?? 0,
  reserved: over.reserved ?? 0,
  remaining: over.remaining,
  carried: 0,
  allowed: true,
  overage: "bill" as const,
  resets: "month" as const,
  resetsAt: monthLater,
});

const aiFeature = (over: {
  readonly used?: number;
  readonly reserved?: number;
  readonly remaining: number;
}) => ({
  creditRates: { default: 1, dimensions: { "gpt-large": 10 } },
  included: null,
  used: over.used ?? 0,
  reserved: over.reserved ?? 0,
  remaining: over.remaining,
  carried: 0,
  allowed: true,
  overage: "block" as const,
  resets: "never" as const,
  resetsAt: null,
});

const closed = (periodStart: DateTime.Utc, periodEnd: DateTime.Utc, nextEnd: DateTime.Utc) =>
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
    new UsageReset({ remaining: { messages: 2000 }, carried: { messages: 0 } }),
    new CreditsExpired({ amount: 0, balanceAfter: 0 }),
  ] as const;

it.effect("PeriodRollover closes the period on the clock without a manual command", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: pro,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.clock(monthLater),
    Story.then(account, ...closed(start, monthLater, march)),
    Story.view(Entitlements, account, { periodEnd: march, standing: "good" }),
  ),
);

it.effect("a closed period schedules the next rollover, so the chain continues", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: pro,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.clock(monthLater),
    Story.then(account, ...closed(start, monthLater, march)),
    Story.clock(march),
    Story.then(account, ...closed(monthLater, march, at("2030-04-01T00:00:00Z"))),
  ),
);

it.effect("Dunning expires an account when grace elapses", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: pro,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.when(
      account,
      new RecordPaymentFailure({ reason: "card_declined", graceUntil: at("2030-01-08T00:00:00Z") }),
    ),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: at("2030-01-08T00:00:00Z"),
        statusAfter: "grace",
        attempt: 1,
        dunningStartedAt: start,
      }),
    ),
    Story.clock(at("2030-01-08T00:00:00Z")),
    Story.then(account, new SubscriptionExpired({ statusAfter: "expired" })),
    Story.view(Entitlements, account, { status: "expired", standing: "blocked" }),
  ),
);

it.effect("a payment before the deadline makes the scheduled expiry a no-op", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: pro,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.when(
      account,
      new RecordPaymentFailure({ reason: "card_declined", graceUntil: at("2030-01-08T00:00:00Z") }),
    ),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: at("2030-01-08T00:00:00Z"),
        statusAfter: "grace",
        attempt: 1,
        dunningStartedAt: start,
      }),
    ),
    Story.when(account, new RecordPayment({ amount: 1900, currency: "usd" })),
    Story.then(
      account,
      new PaymentRecorded({ amount: 1900, currency: "usd", statusAfter: "active" }),
    ),
    Story.clock(at("2030-01-08T00:00:00Z")),
    Story.then(account),
    Story.view(Entitlements, account, { status: "active", standing: "good" }),
  ),
);

it.effect("a trial closes its period on the trial deadline and becomes active", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new StartTrial({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: pro,
        trialEndsAt: at("2030-01-15T00:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new TrialStarted({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: pro,
        remaining: { messages: 2000 },
        periodStart: start,
        periodEnd: at("2030-01-15T00:00:00Z"),
        anchorTz: "UTC",
        trialEndsAt: at("2030-01-15T00:00:00Z"),
        statusAfter: "trialing",
      }),
    ),
    Story.clock(at("2030-01-15T00:00:00Z")),
    Story.then(account, ...closed(start, at("2030-01-15T00:00:00Z"), at("2030-02-15T00:00:00Z"))),
    Story.view(Entitlements, account, { status: "active", standing: "good" }),
  ),
);

it.effect("a trial of an annual tier opens an annual period", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new StartTrial({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: pro,
        trialEndsAt: at("2030-01-15T00:00:00Z"),
        price: annualPrice,
      }),
    ),
    Story.then(
      account,
      new TrialStarted({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: pro,
        remaining: { messages: 2000 },
        periodStart: start,
        periodEnd: at("2030-01-15T00:00:00Z"),
        anchorTz: "UTC",
        trialEndsAt: at("2030-01-15T00:00:00Z"),
        price: annualPrice,
        currency: "usd",
        statusAfter: "trialing",
      }),
    ),
    Story.clock(at("2030-01-15T00:00:00Z")),
    // The conversion keeps the cadence the tier was sold on.
    Story.then(account, ...closed(start, at("2030-01-15T00:00:00Z"), at("2031-01-15T00:00:00Z"))),
    Story.view(Entitlements, account, { status: "active", standing: "good" }),
  ),
);

it.effect("extending a trial reschedules its close to the new deadline", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new StartTrial({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: pro,
        trialEndsAt: at("2030-01-15T00:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new TrialStarted({
        tier: "pro",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: pro,
        remaining: { messages: 2000 },
        periodStart: start,
        periodEnd: at("2030-01-15T00:00:00Z"),
        anchorTz: "UTC",
        trialEndsAt: at("2030-01-15T00:00:00Z"),
        statusAfter: "trialing",
      }),
    ),
    Story.when(account, new ExtendTrial({ trialEndsAt: at("2030-01-22T00:00:00Z") })),
    Story.then(
      account,
      new TrialExtended({
        trialEndsAt: at("2030-01-22T00:00:00Z"),
        periodEnd: at("2030-01-22T00:00:00Z"),
      }),
    ),
    // The old deadline still fires, but it no longer matches the open period.
    Story.clock(at("2030-01-15T00:00:00Z")),
    Story.then(account),
    Story.clock(at("2030-01-22T00:00:00Z")),
    Story.then(account, ...closed(start, at("2030-01-22T00:00:00Z"), at("2030-02-22T00:00:00Z"))),
  ),
);

it.effect("counts payment failures on the billing page, and clears them on recovery", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: pro,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.when(
      account,
      new RecordPaymentFailure({ reason: "card_declined", graceUntil: at("2030-01-08T00:00:00Z") }),
    ),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: at("2030-01-08T00:00:00Z"),
        statusAfter: "grace",
        attempt: 1,
        dunningStartedAt: start,
      }),
    ),
    Story.view(BillingState, account, { status: "grace", dunningAttempts: 1 }),
    // A second failure is the second attempt, not a fresh count.
    Story.when(
      account,
      new RecordPaymentFailure({ reason: "card_declined", graceUntil: at("2030-01-15T00:00:00Z") }),
    ),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: at("2030-01-15T00:00:00Z"),
        statusAfter: "grace",
        attempt: 2,
        dunningStartedAt: start,
      }),
    ),
    Story.view(BillingState, account, { status: "grace", dunningAttempts: 2 }),
    // A failure records the attempt count whether a provider webhook or the
    // dunning policy reported it, and a payment settles the run.
    Story.when(account, new RecordPayment({ amount: 1900, currency: "usd" })),
    Story.then(
      account,
      new PaymentRecorded({ amount: 1900, currency: "usd", statusAfter: "active" }),
    ),
    // A payment settles the dunning run in the aggregate too, not only in the
    // two read models.
    Story.state(account, { dunningAttempts: 0 }),
    Story.view(BillingState, account, { status: "active", dunningAttempts: 0 }),
  ),
);

it.effect("HoldSweep releases a counted hold when its deadline arrives, with no caller", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: pro,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.when(account, new Hold({ holdId: "hold_sweep", feature: "messages", amount: 400 })),
    Story.then(
      account,
      new UsageReserved({
        holdId: "hold_sweep",
        feature: "messages",
        amount: 400,
        rate: 0,
        cost: 0,
        at: start,
        expiresAt: quarter,
        remainingAfter: 1_600,
      }),
    ),
    Story.view(Entitlements, account, {
      features: { messages: messagesFeature({ reserved: 400, remaining: 1_600 }) },
    }),
    // The deadline is the policy's; nobody sends a release.
    Story.clock(quarter),
    Story.then(
      account,
      new UsageReleased({
        holdId: "hold_sweep",
        feature: "messages",
        amount: 400,
        cost: 0,
        remainingAfter: 2_000,
        reason: "expired",
      }),
    ),
    Story.view(Entitlements, account, {
      features: { messages: messagesFeature({ reserved: 0, remaining: 2_000 }) },
    }),
  ),
);

it.effect("HoldSweep returns a credit hold's credits to the one shared pool", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: creditsTerms.credits,
        creditsExpire: creditsTerms.creditsExpire,
        rates: creditsTerms.rates,
        tier: "credits",
        allowances: creditsAllowances,
        price: proPrice,
      }),
    ),
    Story.then(account, creditsActivated),
    Story.when(
      account,
      new Hold({ holdId: "hold_ai", feature: "ai", amount: 100, dimension: "gpt-large" }),
    ),
    Story.then(
      account,
      new UsageReserved({
        holdId: "hold_ai",
        feature: "ai",
        amount: 100,
        dimension: "gpt-large",
        rate: 10,
        cost: 1_000,
        at: start,
        expiresAt: quarter,
        remainingAfter: 49_000,
      }),
    ),
    Story.view(Entitlements, account, {
      credits: 50_000,
      features: { ai: aiFeature({ reserved: 1_000, remaining: 49_000 }) },
    }),
    Story.clock(quarter),
    Story.then(
      account,
      new UsageReleased({
        holdId: "hold_ai",
        feature: "ai",
        amount: 100,
        cost: 1_000,
        remainingAfter: 50_000,
        reason: "expired",
      }),
    ),
    Story.view(Entitlements, account, {
      credits: 50_000,
      features: { ai: aiFeature({ reserved: 0, remaining: 50_000 }) },
    }),
  ),
);

it.effect("a hold settled before its deadline makes the sweep a no-op", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: pro,
        price: proPrice,
      }),
    ),
    Story.then(account, activated),
    Story.when(account, new Hold({ holdId: "hold_sweep", feature: "messages", amount: 400 })),
    Story.then(
      account,
      new UsageReserved({
        holdId: "hold_sweep",
        feature: "messages",
        amount: 400,
        rate: 0,
        cost: 0,
        at: start,
        expiresAt: quarter,
        remainingAfter: 1_600,
      }),
    ),
    // 100 ran: 100 is billed and the other 300 returns in the same command.
    Story.when(account, new SettleHold({ holdId: "hold_sweep", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 100,
        cost: 0,
        creditsAfter: 0,
        usedAfter: 100,
        remainingAfter: 1_900,
      }),
      new UsageSettled({
        holdId: "hold_sweep",
        feature: "messages",
        amount: 100,
        released: 300,
        cost: 0,
        remainingAfter: 1_900,
      }),
    ),
    Story.clock(quarter),
    Story.then(account),
    Story.view(Entitlements, account, {
      features: { messages: messagesFeature({ used: 100, reserved: 0, remaining: 1_900 }) },
    }),
  ),
);
