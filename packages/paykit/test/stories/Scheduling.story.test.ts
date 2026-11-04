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
import {
  CreditsExpired,
  PeriodClosed,
  UsageReset,
} from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { SubscriptionExpired } from "../../src/Subscription/Expire.command.ts";
import { ExtendTrial, TrialExtended } from "../../src/Subscription/ExtendTrial.command.ts";
import { PaymentRecorded, RecordPayment } from "../../src/Subscription/RecordPayment.command.ts";
import {
  PaymentFailed,
  RecordPaymentFailure,
} from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { StartTrial, TrialStarted } from "../../src/Subscription/StartTrial.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier] }));
const pro = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const story = Story.make(PaykitModel, {
  layer: PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
});
const account = Subscription.ref("acct_schedule");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");
const march = at("2030-03-01T00:00:00Z");

const activated = new SubscriptionActivated({
  tier: "pro",
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
    Story.when(account, new Subscribe({ tier: "pro", allowances: pro, price: proPrice })),
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
    Story.when(account, new Subscribe({ tier: "pro", allowances: pro, price: proPrice })),
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
    Story.when(account, new Subscribe({ tier: "pro", allowances: pro, price: proPrice })),
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
    Story.when(account, new Subscribe({ tier: "pro", allowances: pro, price: proPrice })),
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
        allowances: pro,
        trialEndsAt: at("2030-01-15T00:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new TrialStarted({
        tier: "pro",
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

it.effect("extending a trial reschedules its close to the new deadline", () =>
  story(
    Story.provide(Actor, system()),
    Story.clock(start),
    Story.when(
      account,
      new StartTrial({
        tier: "pro",
        allowances: pro,
        trialEndsAt: at("2030-01-15T00:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new TrialStarted({
        tier: "pro",
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
    Story.when(account, new Subscribe({ tier: "pro", allowances: pro, price: proPrice })),
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
      }),
    ),
    Story.view(BillingState, account, { status: "grace", dunningAttempts: 2 }),
    // The retries are the provider's; what paykit records is that they happened,
    // and a payment settles the run.
    Story.when(account, new RecordPayment({ amount: 1900, currency: "usd" })),
    Story.then(
      account,
      new PaymentRecorded({ amount: 1900, currency: "usd", statusAfter: "active" }),
    ),
    Story.view(BillingState, account, { status: "active", dunningAttempts: 0 }),
  ),
);
