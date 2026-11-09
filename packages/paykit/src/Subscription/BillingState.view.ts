import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Actor, mayActOn } from "../Auth/Actor.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Proration } from "../Proration.ts";
import { Interval, Price, TopUpTerms } from "../Tier.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import {
  chargedWith,
  MoneyByCurrency,
  PendingTier,
  refundedWith,
  SubscriptionStatus,
  TopUpFailureRecord,
} from "./Subscription.state.ts";

/**
 * One refund on the page: what the provider acknowledged, and how much of it a
 * provider has since returned. `amount - reversed` is what a reversal may still
 * name, which is the cap `ReverseRefund` applies (ADR 0030).
 */
export const RefundView = Schema.Struct({
  /** The provider's id for the refund. */
  refundId: Schema.String,
  /** Minor units the refund recorded. */
  amount: Schema.Int,
  currency: Schema.String,
  /** Minor units of it a provider has since returned. Absent means none. */
  reversed: Schema.optionalKey(Schema.Int),
  /** Why the money went back, as an operator would tell a customer. */
  reason: Schema.optionalKey(Schema.String),
});

export type RefundView = typeof RefundView.Type;

/** What may still come back from one refund. */
export const outstandingRefundOf = (refund: RefundView): number =>
  Math.max(0, refund.amount - (refund.reversed ?? 0));

/** What a billing page shows. */
export const BillingStateView = Schema.Struct({
  account: Schema.String,
  tier: Schema.String,
  status: SubscriptionStatus,
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  interval: Interval,
  anchorTz: Schema.String,
  cancelAtPeriodEnd: Schema.Boolean,
  credits: Schema.Int,
  /** Credits at or below which a spend buys the deployment's auto top-up pack. */
  topUp: Schema.optionalKey(TopUpTerms),
  /**
   * When the last top-up's cooldown ends. Present means a crossing is deferred
   * until then, so "refilling below 5,000 credits, next refill allowed at 09:30"
   * is one sentence the page can say without reading the log.
   */
  topUpCooldownUntil: Schema.optionalKey(Schema.DateTimeUtc),
  /**
   * The last refill this account's line could not buy, cleared by the next
   * purchase. "Refilling below 5,000 credits, last attempt declined by Stripe"
   * is the sentence that separates a deferred crossing from a broken one.
   */
  topUpFailure: Schema.optionalKey(TopUpFailureRecord),
  /**
   * How many refills in a row a provider has refused. With the tier's budget it
   * is the sentence "failed twice, one attempt left"; without it an operator
   * cannot tell a policy that is still trying from one that gave up (ADR 0031).
   */
  topUpAttempts: Schema.optionalKey(Schema.Int),
  /**
   * Money this account was charged, per currency, in minor units. With
   * `refunded` it is what a console offers to send back: "charged 4,900,
   * refunded 0" is one sentence, and `Refund` caps itself by it.
   */
  charged: Schema.optionalKey(MoneyByCurrency),
  /** Money that went back, per currency. */
  refunded: Schema.optionalKey(MoneyByCurrency),
  /**
   * The refunds themselves, keyed by the provider's id for each. `refunded`
   * answers "how much went back"; this answers "which refunds can still come
   * back", which is what `ReverseRefund` names and a console offers.
   */
  refunds: Schema.optionalKey(Schema.Record(Schema.String, RefundView)),
  /**
   * How many payment failures this standing has recorded, including a failed
   * retry the dunning policy made. The billing page is where an operator sees
   * the run before extending grace.
   */
  dunningAttempts: Schema.Int,
  currency: Schema.optionalKey(Schema.String),
  /** What the account pays for the current tier. Absent on a free tier. */
  price: Schema.optionalKey(Price),
  /**
   * The money the last tier change moved. A positive `due` is what
   * `ChargeProration` bills; a negative one is a credit the next period applies.
   */
  proration: Schema.optionalKey(Proration),
  /** The invoice a positive proration was billed on, once it was. */
  prorationInvoice: Schema.optionalKey(Schema.String),
  trialEndsAt: Schema.optionalKey(Schema.DateTimeUtc),
  graceUntil: Schema.optionalKey(Schema.DateTimeUtc),
  /**
   * The tier this standing moves to when the period ends. Absent when nothing
   * is scheduled, so a console renders the button that schedules one or the
   * one that withdraws it, never both.
   */
  pendingTier: Schema.optionalKey(PendingTier),
});

export type BillingStateView = typeof BillingStateView.Type;

const epoch = DateTime.makeUnsafe(0);

export const initialBillingState: BillingStateView = {
  account: "",
  tier: "",
  status: "expired",
  periodStart: epoch,
  periodEnd: epoch,
  interval: "month",
  anchorTz: "UTC",
  cancelAtPeriodEnd: false,
  credits: 0,
  dunningAttempts: 0,
};

type ViewContext = { readonly key: { readonly id: string } };

const withAccount = (view: BillingStateView, context: ViewContext): BillingStateView => ({
  ...view,
  account: context.key.id,
});

const withoutGrace = (view: BillingStateView, context: ViewContext): BillingStateView => {
  const { graceUntil: _graceUntil, ...rest } = view;

  return withAccount(rest, context);
};

/**
 * One account's billing page state, folded from its events. Guarded by
 * `Session`: an account reads only itself, an admin reads any.
 */
export class BillingState extends Domain.View("BillingState", {
  from: [Subscription],
  key: Subscription,
  state: BillingStateView,
  initial: initialBillingState,
  middleware: [Session],
  rejects: [Forbidden],
  validate: Effect.fn(function* ({ key }) {
    const actor = yield* Actor;

    if (!mayActOn(actor, key.id)) {
      return yield* new Forbidden({
        account: key.id,
        actor: actor.id,
        kind: actor.kind,
        scope: "account",
      });
    }
  }),
  evolve: {
    // A trial starts a fresh standing: the previous price, proration, grace
    // and dunning count do not survive it, and the pool is the one the event
    // grants. The state's `TrialStarted` builds a new object, so this fold
    // must drop the same fields rather than spread them forward.
    TrialStarted: (view, event, context): BillingStateView => {
      const {
        price: _previousPrice,
        proration: _previousProration,
        prorationInvoice: _previousInvoice,
        graceUntil: _previousGrace,
        pendingTier: _previousPending,
        topUp: _previousTopUp,
        topUpCooldownUntil: _previousCooldown,
        ...rest
      } = view;

      return withAccount(
        {
          ...rest,
          tier: event.tier,
          status: "trialing",
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          interval: "month",
          anchorTz: event.anchorTz,
          cancelAtPeriodEnd: false,
          trialEndsAt: event.trialEndsAt,
          credits: event.credits,
          dunningAttempts: 0,
          ...(event.topUp === undefined ? {} : { topUp: event.topUp }),
          ...(event.price === undefined ? {} : { price: event.price }),
          ...(event.currency === undefined ? {} : { currency: event.currency }),
        },
        context,
      );
    },
    // Activation is also a new standing. It drops the trial deadline, the
    // previous tier's money and any grace window, and takes the pool the event
    // records.
    SubscriptionActivated: (view, event, context): BillingStateView => {
      const {
        price: _previousPrice,
        proration: _previousProration,
        prorationInvoice: _previousInvoice,
        trialEndsAt: _previousTrial,
        graceUntil: _previousGrace,
        currency: _previousCurrency,
        pendingTier: _previousPending,
        topUp: _previousTopUp,
        ...rest
      } = view;

      return withAccount(
        {
          ...rest,
          tier: event.tier,
          status: "active",
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          interval: event.interval,
          anchorTz: event.anchorTz,
          cancelAtPeriodEnd: false,
          credits: event.credits,
          dunningAttempts: 0,
          ...(event.topUp === undefined ? {} : { topUp: event.topUp }),
          ...(event.currency === undefined ? {} : { currency: event.currency }),
          ...(event.price === undefined ? {} : { price: event.price }),
        },
        context,
      );
    },
    TierChanged: (view, event, context): BillingStateView => {
      const {
        price: _previousPrice,
        proration: _previous,
        prorationInvoice: _invoiced,
        // A move — now or at the boundary — consumes whatever was scheduled:
        // applying it is why the close emitted this event, and a mid-period
        // `ChangeTier` clears it in the aggregate for the same reason.
        pendingTier: _previousPending,
        topUp: _previousTopUp,
        ...rest
      } = view;

      return withAccount(
        {
          ...rest,
          tier: event.tier,
          interval: event.interval ?? view.interval,
          // A change at the boundary grants the new period's pool, so the page
          // takes the credits the event records. A mid-period change carries the
          // balance it already had.
          credits: event.credits,
          ...(event.topUp === undefined ? {} : { topUp: event.topUp }),
          ...(event.currency === undefined ? {} : { currency: event.currency }),
          ...(event.priceAfter === undefined ? {} : { price: event.priceAfter }),
          ...(event.proration === undefined ? {} : { proration: event.proration }),
        },
        context,
      );
    },
    ProrationInvoiced: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          prorationInvoice: event.invoiceId,
          charged: chargedWith(view, event.currency, event.amount),
        },
        context,
      ),
    PaymentRecorded: (view, event, context): BillingStateView =>
      // A payment settles the dunning run; the count starts over at the next
      // failure rather than carrying last quarter's.
      withoutGrace(
        {
          ...view,
          status: "active",
          dunningAttempts: 0,
          charged: chargedWith(view, event.currency, event.amount),
        },
        context,
      ),
    RefundRecorded: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          refunded: refundedWith(view, event.currency, event.refundedAfter),
          // The refund is now a row the page can offer to reverse, keyed by the
          // provider's id because that is what `ReverseRefund` names.
          refunds: {
            ...view.refunds,
            [event.refundId]: {
              refundId: event.refundId,
              amount: event.amount,
              currency: event.currency,
              ...(event.reason === undefined ? {} : { reason: event.reason }),
            },
          },
        },
        context,
      ),
    // A reversal lowers the same fold, so the page's "refunded" is the money
    // that is actually back rather than everything ever acknowledged.
    RefundReversed: (view, event, context): BillingStateView => {
      const refund = view.refunds?.[event.refundId];

      return withAccount(
        {
          ...view,
          refunded: refundedWith(view, event.currency, event.refundedAfter),
          // The row keeps its place and records what came back, so "4,900
          // refunded, 4,900 returned" is one row rather than none.
          ...(refund === undefined
            ? {}
            : {
                refunds: {
                  ...view.refunds,
                  [event.refundId]: {
                    ...refund,
                    reversed: (refund.reversed ?? 0) + event.amount,
                  },
                },
              }),
        },
        context,
      );
    },
    PaymentFailed: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          status: "grace",
          graceUntil: event.graceUntilAfter,
          dunningAttempts: event.attempt,
        },
        context,
      ),
    // A retry is a policy trigger, not a page value: the charge or the failure
    // that follows it is what the page shows.
    DunningRetryDue: (view, _event, context): BillingStateView => withAccount(view, context),
    GraceEntered: (view, event, context): BillingStateView =>
      withAccount({ ...view, status: "grace", graceUntil: event.graceUntil }, context),
    Recovered: (view, _event, context): BillingStateView =>
      withoutGrace({ ...view, status: "active", dunningAttempts: 0 }, context),
    CreditsGranted: (view, event, context): BillingStateView =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CreditsPurchased: (view, event, context): BillingStateView => {
      // A purchase is the refill that was owed, so the page stops reporting the
      // failure it makes good on and the budget starts over (ADR 0027, ADR 0031).
      const { topUpFailure: _madeGood, ...rest } = view;

      return withAccount(
        {
          ...rest,
          topUpAttempts: 0,
          credits: event.balanceAfter,
          ...(event.price === undefined
            ? {}
            : { charged: chargedWith(view, event.price.currency, event.price.amount) }),
          ...(event.cooldownUntil === undefined ? {} : { topUpCooldownUntil: event.cooldownUntil }),
        },
        context,
      );
    },
    TopUpFailed: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          topUpAttempts: event.attempt,
          topUpFailure: {
            tier: event.tier,
            ...(event.price === undefined ? {} : { price: event.price }),
            provider: event.provider,
            reason: event.reason,
            at: event.at,
          },
        },
        context,
      ),
    // The rung itself changes nothing a page shows; the attempt it becomes is
    // recorded by the purchase or the failure that follows it.
    TopUpRetryDue: (view, _event, context): BillingStateView => withAccount(view, context),
    TopUpCooldownCleared: (view, _event, context): BillingStateView => {
      const { topUpCooldownUntil: _cleared, ...rest } = view;

      return withAccount(rest, context);
    },
    CreditsConsumed: (view, event, context): BillingStateView =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CreditsExpired: (view, event, context): BillingStateView =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CancellationScheduled: (view, _event, context): BillingStateView =>
      withAccount({ ...view, cancelAtPeriodEnd: true }, context),
    CancellationWithdrawn: (view, _event, context): BillingStateView =>
      withAccount({ ...view, cancelAtPeriodEnd: false }, context),
    // The scheduled tier is part of the page: "on pro, moving to small at the
    // period end" is one sentence an operator, and the button beside it, needs.
    TierChangeScheduled: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          pendingTier: {
            tier: event.tier,
            allowances: event.allowances,
            ...(event.price === undefined ? {} : { price: event.price }),
            credits: event.credits,
            creditsExpire: event.creditsExpire,
            ...(event.topUp === undefined ? {} : { topUp: event.topUp }),
            rates: event.rates,
            ...(event.currency === undefined ? {} : { currency: event.currency }),
            ...(event.interval === undefined ? {} : { interval: event.interval }),
          },
        },
        context,
      ),
    TierChangeWithdrawn: (view, _event, context): BillingStateView => {
      const { pendingTier: _withdrawn, ...rest } = view;

      return withAccount(rest, context);
    },
    PeriodClosed: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          status: event.statusAfter,
          periodStart: event.nextPeriodStart,
          periodEnd: event.nextPeriodEnd,
          cancelAtPeriodEnd: event.cancelAtPeriodEndAfter,
        },
        context,
      ),
    SubscriptionExpired: (view, _event, context): BillingStateView =>
      withAccount({ ...view, status: "expired" }, context),
    SubscriptionCanceled: (view, event, context): BillingStateView =>
      withAccount(
        { ...view, status: "canceled", periodEnd: event.canceledAt, cancelAtPeriodEnd: false },
        context,
      ),
    TrialExtended: (view, event, context): BillingStateView =>
      withAccount({ ...view, trialEndsAt: event.trialEndsAt, periodEnd: event.periodEnd }, context),
    // A credit-priced feature spends the shared pool, so the billing page
    // moves with it. A counted feature records the same balance it already had.
    UsageRecorded: (view, event, context): BillingStateView =>
      withAccount({ ...view, credits: event.creditsAfter }, context),
    UsageReserved: (view, _event, context): BillingStateView => withAccount(view, context),
    UsageSettled: (view, _event, context): BillingStateView => withAccount(view, context),
    UsageReleased: (view, _event, context): BillingStateView => withAccount(view, context),
    UsageReset: (view, _event, context): BillingStateView => withAccount(view, context),
    ProviderRefAttached: (view, _event, context): BillingStateView => withAccount(view, context),
  },
}) {}
