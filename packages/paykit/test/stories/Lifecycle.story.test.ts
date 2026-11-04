import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { AlreadyCanceled } from "../../src/Subscription/AlreadyCanceled.rejection.ts";
import {
  AttachProviderRef,
  ProviderRefAttached,
} from "../../src/Subscription/AttachProviderRef.command.ts";
import {
  ClosePeriod,
  CreditsExpired,
  PeriodClosed,
  PeriodNotClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import {
  ConsumeCredits,
  CreditExceedsBalance,
  CreditsConsumed,
} from "../../src/Subscription/ConsumeCredits.command.ts";
import {
  AlreadyInGrace,
  EnterGrace,
  GraceEntered,
} from "../../src/Subscription/EnterGrace.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Expire, SubscriptionExpired } from "../../src/Subscription/Expire.command.ts";
import {
  ExtendTrial,
  TrialExtended,
  TrialNotActive,
} from "../../src/Subscription/ExtendTrial.command.ts";
import { CreditsGranted, GrantCredits } from "../../src/Subscription/GrantCredits.command.ts";
import { NotInGrace } from "../../src/Subscription/NotInGrace.rejection.ts";
import { NotScheduled } from "../../src/Subscription/NotScheduled.rejection.ts";
import { NotSubscribed } from "../../src/Subscription/NotSubscribed.rejection.ts";
import { PaymentRecorded, RecordPayment } from "../../src/Subscription/RecordPayment.command.ts";
import {
  PaymentFailed,
  RecordPaymentFailure,
} from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Recover, Recovered } from "../../src/Subscription/Recover.command.ts";
import { CancellationWithdrawn, Resume } from "../../src/Subscription/Resume.command.ts";
import {
  CancellationScheduled,
  ScheduleCancellation,
} from "../../src/Subscription/ScheduleCancellation.command.ts";
import { StartTrial, TrialStarted } from "../../src/Subscription/StartTrial.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  StandingBlocksUsage,
  TrackUsage,
  UsageRecorded,
} from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier, proTier] }));

const allowances = (id: string) => {
  const found = allowancesOf(testCatalog, id);
  if (found === null) throw new Error(`missing ${id}`);
  return found;
};

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const proAllowances = allowances("pro");
const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});
const account = Subscription.ref("acct_life");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const graceUntil = at("2030-01-08T00:00:00Z");

const activated = new SubscriptionActivated({
  tier: "pro",
  allowances: proAllowances,
  remaining: { messages: 2000 },
  periodStart: start,
  periodEnd: monthLater,
  anchorTz: "UTC",
  interval: "month",
  currency: "usd",
  price: proPrice,
  statusAfter: "active",
});

const subscribed = [
  Story.clock(start),
  Story.when(account, new Subscribe({ tier: "pro", allowances: proAllowances, price: proPrice })),
  Story.then(account, activated),
] as const;

it.effect("fails a charge, enters grace, and recovers on payment", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(account, new RecordPayment({ amount: 1900, currency: "usd" })),
    Story.rejected(new NotInGrace({ status: "active" })),
    Story.when(account, new RecordPaymentFailure({ reason: "card_declined", graceUntil })),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: graceUntil,
        statusAfter: "grace",
        attempt: 1,
      }),
    ),
    Story.view(Entitlements, account, { standing: "grace", status: "grace" }),
    Story.when(account, new EnterGrace({ graceUntil })),
    Story.rejected(new AlreadyInGrace()),
    Story.when(account, new RecordPayment({ amount: 1900, currency: "usd" })),
    Story.then(
      account,
      new PaymentRecorded({ amount: 1900, currency: "usd", statusAfter: "active" }),
    ),
    Story.view(Entitlements, account, { standing: "good", status: "active" }),
    Story.when(account, new Recover()),
    Story.rejected(new NotInGrace({ status: "active" })),
  ),
);

it.effect("enters grace from the console and recovers without a payment", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(account, new EnterGrace({ graceUntil })),
    Story.then(account, new GraceEntered({ graceUntil, statusAfter: "grace" })),
    Story.when(account, new Recover()),
    Story.then(account, new Recovered({ statusAfter: "active" })),
  ),
);

it.effect("grants and spends credits, refusing to overdraw", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(account, new GrantCredits({ amount: 500 })),
    Story.then(account, new CreditsGranted({ amount: 500, balanceAfter: 500 })),
    Story.replied({ balance: 500 }),
    Story.when(account, new ConsumeCredits({ amount: 200 })),
    Story.then(account, new CreditsConsumed({ amount: 200, balanceAfter: 300 })),
    Story.replied({ balance: 300 }),
    Story.when(account, new ConsumeCredits({ amount: 301 })),
    Story.rejected(new CreditExceedsBalance({ balance: 300, requested: 301 })),
  ),
);

it.effect("schedules and withdraws a cancellation", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(account, new ScheduleCancellation()),
    Story.then(account, new CancellationScheduled({ cancelAtPeriodEndAfter: true })),
    Story.when(account, new ScheduleCancellation()),
    Story.rejected(new AlreadyCanceled()),
    Story.when(account, new Resume()),
    Story.then(account, new CancellationWithdrawn({ cancelAtPeriodEndAfter: false })),
    Story.when(account, new Resume()),
    Story.rejected(new NotScheduled()),
  ),
);

it.effect("closes the period, resets usage, expires credits and opens the next period", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(account, new TrackUsage({ feature: "messages", amount: 500 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "messages",
        amount: 500,
        usedAfter: 500,
        remainingAfter: 1500,
      }),
    ),
    Story.when(account, new GrantCredits({ amount: 250 })),
    Story.then(account, new CreditsGranted({ amount: 250, balanceAfter: 250 })),
    Story.replied({ balance: 250 }),
    Story.when(account, new ClosePeriod({ periodEnd: monthLater })),
    Story.rejected(new PeriodNotClosed({ periodEnd: monthLater, now: start })),
    Story.clock(monthLater),
    Story.then(
      account,
      new PeriodClosed({
        periodStart: start,
        periodEnd: monthLater,
        nextPeriodStart: monthLater,
        nextPeriodEnd: at("2030-03-01T00:00:00Z"),
        statusAfter: "active",
        standingAfter: "good",
        cancelAtPeriodEndAfter: false,
      }),
      new UsageReset({ remaining: { messages: 2000 } }),
      new CreditsExpired({ amount: 250, balanceAfter: 0 }),
    ),
    Story.view(Entitlements, account, {
      periodEnd: at("2030-03-01T00:00:00Z"),
      features: {
        messages: {
          included: 2000,
          used: 0,
          reserved: 0,
          allowed: true,
          remaining: 2000,
          overage: "bill",
          resets: "month",
          resetsAt: at("2030-03-01T00:00:00Z"),
        },
      },
    }),
    Story.when(account, new ClosePeriod({ periodEnd: monthLater })),
    Story.rejected(new PeriodNotClosed({ periodEnd: monthLater, now: at("2030-02-01T00:00:00Z") })),
  ),
);

it.effect("a scheduled cancellation blocks usage once the period closes", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(account, new ScheduleCancellation()),
    Story.then(account, new CancellationScheduled({ cancelAtPeriodEndAfter: true })),
    Story.clock(monthLater),
    Story.then(
      account,
      new PeriodClosed({
        periodStart: start,
        periodEnd: monthLater,
        nextPeriodStart: monthLater,
        nextPeriodEnd: at("2030-03-01T00:00:00Z"),
        statusAfter: "canceled",
        standingAfter: "blocked",
        cancelAtPeriodEndAfter: true,
      }),
      new UsageReset({ remaining: { messages: 2000 } }),
      new CreditsExpired({ amount: 0, balanceAfter: 0 }),
    ),
    Story.view(Entitlements, account, { status: "canceled", standing: "blocked" }),
    Story.when(account, new TrackUsage({ feature: "messages", amount: 1 })),
    Story.rejected(new StandingBlocksUsage({ standing: "blocked", status: "canceled" })),
  ),
);

it.effect("expires only from grace and is terminal", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(account, new Expire()),
    Story.rejected(new NotInGrace({ status: "active" })),
    Story.when(account, new RecordPaymentFailure({ reason: "card_declined", graceUntil })),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: graceUntil,
        statusAfter: "grace",
        attempt: 1,
      }),
    ),
    Story.when(account, new Expire()),
    Story.then(account, new SubscriptionExpired({ statusAfter: "expired" })),
    Story.when(account, new Expire()),
    Story.then(account),
    Story.view(Entitlements, account, { status: "expired", standing: "blocked" }),
  ),
);

it.effect("extends a trial and refuses when there is none", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new StartTrial({
        tier: "pro",
        allowances: proAllowances,
        trialEndsAt: at("2030-01-15T00:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new TrialStarted({
        tier: "pro",
        allowances: proAllowances,
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
    Story.when(account, new ExtendTrial({ trialEndsAt: at("2030-02-01T00:00:00Z") })),
    Story.then(
      account,
      new TrialExtended({
        trialEndsAt: at("2030-02-01T00:00:00Z"),
        periodEnd: at("2030-02-01T00:00:00Z"),
      }),
    ),
    Story.when(account, new Expire()),
    Story.rejected(new NotInGrace({ status: "trialing" })),
  ),
);

it.effect("attaches vendor refs without changing entitlements", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(
      account,
      new AttachProviderRef({
        provider: "stripe",
        refs: { customer: "cus_1", subscription: "sub_1" },
      }),
    ),
    Story.then(
      account,
      new ProviderRefAttached({
        provider: "stripe",
        refs: { customer: "cus_1", subscription: "sub_1" },
      }),
    ),
    Story.state(account, {
      refs: { stripe: { customer: "cus_1", subscription: "sub_1" } },
    }),
    Story.view(Entitlements, account, { tier: "pro", standing: "good" }),
  ),
);

it.effect("refuses commands that need a standing", () =>
  story(
    Story.provide(Actor, system()),
    Story.when(account, new ScheduleCancellation()),
    Story.rejected(new NotSubscribed({ account: "acct_life" })),
    Story.when(account, new GrantCredits({ amount: 10 })),
    Story.rejected(new NotSubscribed({ account: "acct_life" })),
    Story.when(account, new ExtendTrial({ trialEndsAt: graceUntil })),
    Story.rejected(new NotSubscribed({ account: "acct_life" })),
    Story.when(account, new Expire()),
    Story.rejected(new NotInGrace({ status: "none" })),
  ),
);

it.effect("a trial started after a free tier keeps the account's credits and refs", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(account, new Subscribe({ tier: "free", allowances: allowances("free") })),
    Story.then(
      account,
      new SubscriptionActivated({
        tier: "free",
        allowances: allowances("free"),
        remaining: { messages: 100 },
        periodStart: start,
        periodEnd: monthLater,
        anchorTz: "UTC",
        interval: "month",
        statusAfter: "active",
      }),
    ),
    Story.when(account, new GrantCredits({ amount: 300 })),
    Story.then(account, new CreditsGranted({ amount: 300, balanceAfter: 300 })),
    Story.replied({ balance: 300 }),
    Story.when(
      account,
      new AttachProviderRef({ provider: "polar", refs: { customer: "cus_polar" } }),
    ),
    Story.then(
      account,
      new ProviderRefAttached({ provider: "polar", refs: { customer: "cus_polar" } }),
    ),
    Story.when(
      account,
      new StartTrial({
        tier: "pro",
        allowances: proAllowances,
        trialEndsAt: at("2030-01-15T00:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new TrialStarted({
        tier: "pro",
        allowances: proAllowances,
        remaining: { messages: 2000 },
        periodStart: start,
        periodEnd: at("2030-01-15T00:00:00Z"),
        anchorTz: "UTC",
        trialEndsAt: at("2030-01-15T00:00:00Z"),
        statusAfter: "trialing",
      }),
    ),
    Story.state(account, {
      credits: 300,
      refs: { polar: { customer: "cus_polar" } },
      trialUsed: true,
    }),
    Story.when(account, new ExtendTrial({ trialEndsAt: graceUntil })),
    Story.then(account, new TrialExtended({ trialEndsAt: graceUntil, periodEnd: graceUntil })),
  ),
);

it.effect("refuses to extend a trial that is not running", () =>
  story(
    Story.provide(Actor, system()),
    ...subscribed,
    Story.when(account, new ExtendTrial({ trialEndsAt: graceUntil })),
    Story.rejected(new TrialNotActive()),
  ),
);

it("the model has no definition problems", () => {
  expect(Domain.verify(PaykitModel)).toEqual([]);
});
