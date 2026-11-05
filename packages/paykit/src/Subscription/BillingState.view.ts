import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Actor, mayActOn } from "../Auth/Actor.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Proration } from "../Proration.ts";
import { Interval, Price } from "../Tier.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import { SubscriptionStatus } from "./Subscription.state.ts";

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
  /**
   * How many payment failures this standing has recorded. The retries
   * themselves are the provider's; this is what paykit knows about them, and
   * the billing page is where an operator sees it before extending grace.
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
      return yield* new Forbidden({ account: key.id, actor: actor.id, kind: actor.kind });
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
        ...rest
      } = view;
      return withAccount(
        {
          ...rest,
          tier: event.tier,
          interval: event.interval ?? view.interval,
          ...(event.currency === undefined ? {} : { currency: event.currency }),
          ...(event.priceAfter === undefined ? {} : { price: event.priceAfter }),
          ...(event.proration === undefined ? {} : { proration: event.proration }),
        },
        context,
      );
    },
    ProrationInvoiced: (view, event, context): BillingStateView =>
      withAccount({ ...view, prorationInvoice: event.invoiceId }, context),
    PaymentRecorded: (view, _event, context): BillingStateView =>
      // A payment settles the dunning run; the count starts over at the next
      // failure rather than carrying last quarter's.
      withoutGrace({ ...view, status: "active", dunningAttempts: 0 }, context),
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
    GraceEntered: (view, event, context): BillingStateView =>
      withAccount({ ...view, status: "grace", graceUntil: event.graceUntil }, context),
    Recovered: (view, _event, context): BillingStateView =>
      withoutGrace({ ...view, status: "active", dunningAttempts: 0 }, context),
    CreditsGranted: (view, event, context): BillingStateView =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CreditsPurchased: (view, event, context): BillingStateView =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CreditsConsumed: (view, event, context): BillingStateView =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CreditsExpired: (view, event, context): BillingStateView =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CancellationScheduled: (view, _event, context): BillingStateView =>
      withAccount({ ...view, cancelAtPeriodEnd: true }, context),
    CancellationWithdrawn: (view, _event, context): BillingStateView =>
      withAccount({ ...view, cancelAtPeriodEnd: false }, context),
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
