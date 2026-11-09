import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import {
  PaymentDeclined,
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
  paymentsRouter,
  type MoneyProvider,
  type PaymentCapability,
} from "../../src/Payments.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import {
  dunning,
  dunningChargeCommandId,
  type DunningInvalid,
} from "../../src/Subscription/Dunning.policy.ts";
import { DunningRetryDue } from "../../src/Subscription/DunningRetry.command.ts";
import { SubscriptionExpired } from "../../src/Subscription/Expire.command.ts";
import { PaymentRecorded } from "../../src/Subscription/RecordPayment.command.ts";
import {
  PaymentFailed,
  RecordPaymentFailure,
} from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };
const terms = { messages: allowance(messages, { included: 100 }) };

const account = Subscription.ref("acct_dunning");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const subscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      tier: "plan",
      allowances: terms,
      price,
      credits: 0,
      creditsExpire: "period",
      rates: {},
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "plan",
      allowances: terms,
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

/** A provider that refuses every saved-method charge. */
const declining = (declined: PaymentDeclined): MoneyProvider<"memory"> => {
  const capabilities: ReadonlySet<PaymentCapability> = new Set(["charge"]);

  const missing = (op: string) =>
    Effect.fail(new ProviderCapabilityMissing({ provider: "declining", op }));

  const service = Payments.toLayer(
    Effect.succeed({
      createCheckout: () => missing("createCheckout"),
      createInvoice: () => missing("createInvoice"),
      charge: () => Effect.fail(declined),
      refund: () => missing("refund"),
      createPortal: () => missing("createPortal"),
      setupPayment: () => missing("setupPayment"),
      reportUsage: () => missing("reportUsage"),
      setQuantity: () => missing("setQuantity"),
    }),
  );

  return {
    name: "declining",
    kind: "memory",
    capabilities,
    payments: Layer.merge(
      service,
      Layer.succeed(PaymentsProvider, { name: "declining", capabilities }),
    ),
  };
};

const storyWith = (provider: MoneyProvider, retries: ReadonlyArray<Duration.Duration>) => {
  const handlers = PaykitHandlers.pipe(
    Layer.provide(MemoryBillingReadStore),
    Layer.provideMerge(paymentsRouter(provider)),
  );

  return Story.make(PaykitModel, {
    layer: handlers.pipe(Layer.provideMerge(dunning({ retries }).pipe(Layer.orDie))),
  });
};

const failedAt = new PaymentFailed({
  reason: "card_declined",
  graceUntilAfter: at("2030-01-01T03:00:00Z"),
  statusAfter: "grace",
  attempt: 1,
  dunningStartedAt: start,
});

it.effect("retries a failed payment on the ladder and records the charge that recovers it", () =>
  storyWith(PaymentsMemory(), [Duration.hours(1), Duration.hours(2)])(
    ...subscribed,
    Story.when(
      account,
      new RecordPaymentFailure({
        reason: "card_declined",
        graceUntil: at("2030-01-01T03:00:00Z"),
      }),
    ),
    Story.then(account, failedAt),
    // The first rung is one hour after the first failure.
    Story.clock(at("2030-01-01T01:00:00Z")),
    Story.then(
      account,
      new DunningRetryDue({
        attempt: 2,
        startedAt: start,
        amount: 1_900,
        currency: "usd",
      }),
    ),
    Story.call(Payments.charge, {
      account: account.id,
      amount: 1_900,
      currency: "usd",
      commandId: dunningChargeCommandId(account.id, start, 2),
    }),
    Story.returned(Payments.charge, { chargeId: "ch_1" }),
    Story.then(
      account,
      new PaymentRecorded({ amount: 1_900, currency: "usd", statusAfter: "active" }),
    ),
    // The second rung is already scheduled; a recovered standing makes it a no-op.
    Story.clock(at("2030-01-01T02:00:00Z")),
    Story.then(account),
    // And the grace deadline, now passed, is a no-op too.
    Story.clock(at("2030-01-01T03:00:00Z")),
    Story.then(account),
    Story.view(BillingState, account, { status: "active", dunningAttempts: 0 }),
  ),
);

it.effect("does not charge a rung after the run has moved past its attempt", () =>
  storyWith(PaymentsMemory(), [Duration.hours(1)])(
    ...subscribed,
    Story.when(
      account,
      new RecordPaymentFailure({
        reason: "card_declined",
        graceUntil: at("2030-01-01T03:00:00Z"),
      }),
    ),
    Story.then(account, failedAt),
    // A provider reports another failure before the first rung is due. The
    // rung still fires, but it was scheduled after attempt 1 and the run is
    // already at attempt 2, so it must not charge the card.
    Story.clock(at("2030-01-01T00:30:00Z")),
    Story.when(
      account,
      new RecordPaymentFailure({
        reason: "card_declined",
        graceUntil: at("2030-01-01T03:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: at("2030-01-01T03:00:00Z"),
        statusAfter: "grace",
        attempt: 2,
        dunningStartedAt: start,
      }),
    ),
    Story.clock(at("2030-01-01T01:00:00Z")),
    Story.then(account),
  ),
);

it.effect("records each failed rung and expires the standing when grace elapses", () => {
  const declined = new PaymentDeclined({
    provider: "declining",
    code: "card_declined",
    message: "the card was declined",
  });

  return storyWith(declining(declined), [Duration.hours(1), Duration.hours(2)])(
    ...subscribed,
    Story.when(
      account,
      new RecordPaymentFailure({
        reason: "card_declined",
        graceUntil: at("2030-01-01T03:00:00Z"),
      }),
    ),
    Story.then(account, failedAt),
    Story.clock(at("2030-01-01T01:00:00Z")),
    Story.then(
      account,
      new DunningRetryDue({
        attempt: 2,
        startedAt: start,
        amount: 1_900,
        currency: "usd",
      }),
    ),
    Story.call(Payments.charge, {
      account: account.id,
      amount: 1_900,
      currency: "usd",
      commandId: dunningChargeCommandId(account.id, start, 2),
    }),
    Story.failed(Payments.charge, declined),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: at("2030-01-01T03:00:00Z"),
        statusAfter: "grace",
        attempt: 2,
        dunningStartedAt: start,
      }),
    ),
    // The second rung is two hours after the first failure, not two hours
    // after the first retry: the ladder is measured from the failure.
    Story.clock(at("2030-01-01T02:00:00Z")),
    Story.then(
      account,
      new DunningRetryDue({
        attempt: 3,
        startedAt: start,
        amount: 1_900,
        currency: "usd",
      }),
    ),
    Story.call(Payments.charge, {
      account: account.id,
      amount: 1_900,
      currency: "usd",
      commandId: dunningChargeCommandId(account.id, start, 3),
    }),
    Story.failed(Payments.charge, declined),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: at("2030-01-01T03:00:00Z"),
        statusAfter: "grace",
        attempt: 3,
        dunningStartedAt: start,
      }),
    ),
    Story.clock(at("2030-01-01T03:00:00Z")),
    Story.then(account, new SubscriptionExpired({ statusAfter: "expired" })),
    Story.view(BillingState, account, { status: "expired" }),
  );
});

it.effect("refuses a ladder entry that is not a positive duration", () =>
  Effect.gen(function* () {
    const outcome = yield* Effect.provide(
      Effect.void,
      dunning({ retries: [Duration.hours(1), Duration.zero] }),
    ).pipe(
      Effect.match({
        onFailure: (error: DunningInvalid) => error,
        onSuccess: () => null,
      }),
    );

    expect(outcome?._tag).toBe("DunningInvalid");
    expect(outcome?.index).toBe(1);
  }),
);

it.effect("does not retry when the ladder has no rung left", () =>
  storyWith(PaymentsMemory(), [])(
    ...subscribed,
    Story.when(
      account,
      new RecordPaymentFailure({
        reason: "card_declined",
        graceUntil: at("2030-01-01T01:00:00Z"),
      }),
    ),
    Story.then(
      account,
      new PaymentFailed({
        reason: "card_declined",
        graceUntilAfter: at("2030-01-01T01:00:00Z"),
        statusAfter: "grace",
        attempt: 1,
        dunningStartedAt: start,
      }),
    ),
    Story.clock(at("2030-01-01T01:00:00Z")),
    Story.then(account, new SubscriptionExpired({ statusAfter: "expired" })),
  ),
);
