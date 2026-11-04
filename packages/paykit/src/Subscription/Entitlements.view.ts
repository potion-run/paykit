import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Overage, Resets } from "../Allowance.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import { SubscriptionStatus, Standing } from "./Subscription.state.ts";

/** What a tier grants, what has been used, and when it resets. */
export const FeatureEntitlement = Schema.Struct({
  included: Schema.Int,
  used: Schema.Int,
  remaining: Schema.Int,
  overage: Overage,
  resets: Resets,
  resetsAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type FeatureEntitlement = typeof FeatureEntitlement.Type;

/** The `check()` read model: per-feature remaining and the account's standing. */
export const EntitlementsState = Schema.Struct({
  account: Schema.String,
  tier: Schema.String,
  status: SubscriptionStatus,
  standing: Standing,
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  cancelAtPeriodEnd: Schema.Boolean,
  credits: Schema.Int,
  currency: Schema.optionalKey(Schema.String),
  features: Schema.Record(Schema.String, FeatureEntitlement),
});
export type EntitlementsState = typeof EntitlementsState.Type;

const epoch = DateTime.makeUnsafe(0);

export const initialEntitlements: EntitlementsState = {
  account: "",
  tier: "",
  status: "expired",
  standing: "blocked",
  periodStart: epoch,
  periodEnd: epoch,
  cancelAtPeriodEnd: false,
  credits: 0,
  features: {},
};

type ViewContext = { readonly key: { readonly id: string } };

const withAccount = (view: EntitlementsState, context: ViewContext): EntitlementsState => ({
  ...view,
  account: context.key.id,
});

/**
 * The read `check()` answers from. It folds one account's events, so a
 * cross-account dashboard is `BillingRead`, never this view.
 */
export class Entitlements extends Domain.View("Entitlements", {
  from: [Subscription],
  key: Subscription,
  state: EntitlementsState,
  initial: initialEntitlements,
  evolve: {
    TrialStarted: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...view,
          tier: event.tier,
          status: "trialing",
          standing: "good",
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          cancelAtPeriodEnd: false,
          features: featuresOf(event.allowances, {}, event.remaining, event.periodEnd),
        },
        context,
      ),
    SubscriptionActivated: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...view,
          tier: event.tier,
          status: "active",
          standing: "good",
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          cancelAtPeriodEnd: false,
          ...(event.currency === undefined ? {} : { currency: event.currency }),
          features: featuresOf(event.allowances, {}, event.remaining, event.periodEnd),
        },
        context,
      ),
    TierChanged: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...view,
          tier: event.tier,
          ...(event.currency === undefined ? {} : { currency: event.currency }),
          features: featuresOf(
            event.allowances,
            view.features,
            event.remaining,
            view.periodEnd,
            true,
          ),
        },
        context,
      ),
    UsageRecorded: (view, event, context): EntitlementsState => {
      const feature = view.features[event.feature];
      if (feature === undefined) return withAccount(view, context);
      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              used: event.usedAfter,
              remaining: event.remainingAfter,
            },
          },
        },
        context,
      );
    },
    PaymentFailed: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, status: "grace", standing: "grace" }, context),
    GraceEntered: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, status: "grace", standing: "grace" }, context),
    PaymentRecorded: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, status: "active", standing: "good" }, context),
    Recovered: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, status: "active", standing: "good" }, context),
    SubscriptionExpired: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, status: "expired", standing: "blocked" }, context),
    PeriodClosed: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...view,
          status: event.statusAfter,
          standing: event.standingAfter,
          periodStart: event.nextPeriodStart,
          periodEnd: event.nextPeriodEnd,
          cancelAtPeriodEnd: event.cancelAtPeriodEndAfter,
          features: Object.fromEntries(
            Object.entries(view.features).map(([feature, value]) => [
              feature,
              { ...value, resetsAt: value.resets === "never" ? null : event.nextPeriodEnd },
            ]),
          ),
        },
        context,
      ),
    UsageReset: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...view,
          features: Object.fromEntries(
            Object.entries(view.features).map(([feature, value]) => [
              feature,
              { ...value, used: 0, remaining: event.remaining[feature] ?? value.included },
            ]),
          ),
        },
        context,
      ),
    CancellationScheduled: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, cancelAtPeriodEnd: true }, context),
    CancellationWithdrawn: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, cancelAtPeriodEnd: false }, context),
    TrialExtended: (view, event, context): EntitlementsState =>
      withAccount(
        {
          ...view,
          periodEnd: event.periodEnd,
          features: Object.fromEntries(
            Object.entries(view.features).map(([feature, value]) => [
              feature,
              {
                ...value,
                resetsAt: value.resets === "never" ? null : event.periodEnd,
              },
            ]),
          ),
        },
        context,
      ),
    CreditsGranted: (view, event, context): EntitlementsState =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CreditsConsumed: (view, event, context): EntitlementsState =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    CreditsExpired: (view, event, context): EntitlementsState =>
      withAccount({ ...view, credits: event.balanceAfter }, context),
    ProviderRefAttached: (view, _event, context): EntitlementsState => withAccount(view, context),
  },
}) {}

const featuresOf = (
  allowances: Readonly<Record<string, { included: number; overage: Overage; resets: Resets }>>,
  previous: Readonly<Record<string, FeatureEntitlement>>,
  remaining: Readonly<Record<string, number>>,
  periodEnd: DateTime.Utc,
  keepUsage = false,
): Record<string, FeatureEntitlement> =>
  Object.fromEntries(
    Object.entries(allowances).map(([feature, allowance]) => {
      const used = keepUsage ? (previous[feature]?.used ?? 0) : 0;
      return [
        feature,
        {
          included: allowance.included,
          used,
          remaining: remaining[feature] ?? allowance.included,
          overage: allowance.overage,
          resets: allowance.resets,
          resetsAt: allowance.resets === "never" ? null : periodEnd,
        },
      ];
    }),
  );
