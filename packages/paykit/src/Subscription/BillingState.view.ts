import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Interval } from "../Tier.ts";
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
  currency: Schema.optionalKey(Schema.String),
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

/** One account's billing page state, folded from its events. */
export class BillingState extends Domain.View("BillingState", {
  from: [Subscription],
  key: Subscription,
  state: BillingStateView,
  initial: initialBillingState,
  evolve: {
    TrialStarted: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          tier: event.tier,
          status: "trialing",
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          anchorTz: event.anchorTz,
          cancelAtPeriodEnd: false,
          trialEndsAt: event.trialEndsAt,
        },
        context,
      ),
    SubscriptionActivated: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          tier: event.tier,
          status: "active",
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          interval: event.interval,
          anchorTz: event.anchorTz,
          cancelAtPeriodEnd: false,
          ...(event.currency === undefined ? {} : { currency: event.currency }),
        },
        context,
      ),
    TierChanged: (view, event, context): BillingStateView =>
      withAccount(
        {
          ...view,
          tier: event.tier,
          interval: event.interval ?? view.interval,
          ...(event.currency === undefined ? {} : { currency: event.currency }),
        },
        context,
      ),
    PaymentRecorded: (view, _event, context): BillingStateView =>
      withoutGrace({ ...view, status: "active" }, context),
    PaymentFailed: (view, event, context): BillingStateView =>
      withAccount({ ...view, status: "grace", graceUntil: event.graceUntilAfter }, context),
    GraceEntered: (view, event, context): BillingStateView =>
      withAccount({ ...view, status: "grace", graceUntil: event.graceUntil }, context),
    Recovered: (view, _event, context): BillingStateView =>
      withoutGrace({ ...view, status: "active" }, context),
    CreditsGranted: (view, event, context): BillingStateView =>
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
    // Usage and vendor refs do not move a number the billing page shows, but
    // applying them keeps this view's emitted log the whole subscription log.
    UsageRecorded: (view, _event, context): BillingStateView => withAccount(view, context),
    UsageReset: (view, _event, context): BillingStateView => withAccount(view, context),
    ProviderRefAttached: (view, _event, context): BillingStateView => withAccount(view, context),
  },
}) {}
