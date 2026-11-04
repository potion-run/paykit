import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AllowanceKind, Included, Overage, Resets } from "../Allowance.ts";
import { Actor, mayActOn } from "../Auth/Actor.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { CreditRates } from "../Feature.ts";
import { Proration } from "../Proration.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import {
  SubscriptionStatus,
  Standing,
  creditRateOf,
  includedRemainingOf,
  recordedCount,
} from "./Subscription.state.ts";

/** What a tier grants, what has been used, and when it resets. */
export const FeatureEntitlement = Schema.Struct({
  /**
   * `metered` counts and `flag` does not. Absent means `metered`, so a view
   * recorded before the field existed still reads.
   */
  kind: Schema.optionalKey(AllowanceKind),
  /**
   * The rate card of a credit-priced feature: credits per unit by dimension.
   * Present exactly when the feature is priced in credits, in which case
   * `remaining` is the account's shared pool and there is no `included`.
   */
  creditRates: Schema.optionalKey(CreditRates),
  /**
   * What the tier includes: a count, or `"unlimited"`. `null` for a
   * credit-priced feature, which includes no units of its own.
   */
  included: Schema.NullOr(Included),
  used: Schema.Int,
  /** Held by open reservations: out of `remaining`, not yet `used`. */
  reserved: Schema.Int,
  /** Spendable now. `null` means there is no count: an unlimited allowance or a flag. */
  remaining: Schema.NullOr(Schema.Int),
  /**
   * How much of `remaining` rolled over from the period that just closed, at
   * most `included`. `0` when this period is the first or the allowance does
   * not carry — so a console can say "1,480 of 2,000 included, 700 rolled
   * over".
   */
  carried: Schema.Int,
  /**
   * Whether the account may use one more unit right now: the same judgement
   * `check({ amount: 1 })` makes, carried in the read model so an agent reading
   * this view gets the answer without doing the arithmetic.
   */
  allowed: Schema.Boolean,
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
  /** Payment failures recorded for this standing; the retries are the provider's. */
  dunningAttempts: Schema.Int,
  /** The money the last tier change moved, and the invoice it was billed on. */
  proration: Schema.optionalKey(Proration),
  prorationInvoice: Schema.optionalKey(Schema.String),
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
  dunningAttempts: 0,
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
 *
 * Guarded by `Session`: an account reads only itself, an admin reads any.
 */
export class Entitlements extends Domain.View("Entitlements", {
  from: [Subscription],
  key: Subscription,
  state: EntitlementsState,
  initial: initialEntitlements,
  middleware: [Session],
  rejects: [Forbidden],
  validate: Effect.fn(function* ({ key }) {
    const actor = yield* Actor;
    if (!mayActOn(actor, key.id)) {
      return yield* new Forbidden({ account: key.id, actor: actor.id, kind: actor.kind });
    }
  }),
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
          credits: event.credits,
          features: featuresOf(
            event.allowances,
            event.rates,
            event.credits,
            // A fresh standing holds nothing.
            0,
            {},
            event.remaining,
            event.periodEnd,
            "good",
          ),
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
          credits: event.credits,
          features: featuresOf(
            event.allowances,
            event.rates,
            event.credits,
            // A fresh standing holds nothing.
            0,
            {},
            event.remaining,
            event.periodEnd,
            "good",
          ),
        },
        context,
      ),
    TierChanged: (view, event, context): EntitlementsState => {
      // A new tier change replaces what the old one owed and the invoice that
      // settled it; carrying either forward would report stale money.
      const { proration: _previous, prorationInvoice: _invoiced, ...rest } = view;
      return withAccount(
        {
          ...rest,
          tier: event.tier,
          ...(event.currency === undefined ? {} : { currency: event.currency }),
          features: featuresOf(
            event.allowances,
            event.rates,
            // A tier change carries the balance over; the new cards price it.
            view.credits,
            heldOf(view.features),
            view.features,
            event.remaining,
            view.periodEnd,
            view.standing,
            true,
          ),
          ...(event.proration === undefined ? {} : { proration: event.proration }),
        },
        context,
      );
    },
    UsageRecorded: (view, event, context): EntitlementsState => {
      const feature = view.features[event.feature];
      if (feature === undefined) return withAccount(view, context);
      // A credit-priced feature spends the shared pool, so it moves the balance
      // and leaves `remaining` to the pool helper; a counted feature moves its
      // own counter.
      if (feature.creditRates !== undefined) {
        const spent = withCreditsOf(view, event.creditsAfter, heldOf(view.features));
        return withAccount(
          {
            ...spent,
            features: {
              ...spent.features,
              [event.feature]: { ...spent.features[event.feature]!, used: event.usedAfter },
            },
          },
          context,
        );
      }
      return withAccount(
        {
          ...view,
          credits: event.creditsAfter,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              used: event.usedAfter,
              remaining: event.remainingAfter,
              allowed: allowsOne(view.standing, feature.overage, event.remainingAfter),
            },
          },
        },
        context,
      );
    },
    // A hold leaves `remaining` at hold time, so `check()` refuses a second
    // caller the unit the first one holds. `reserved` is the fold of the open
    // holds, not a counter a command writes.
    UsageReserved: (view, event, context): EntitlementsState => {
      const feature = view.features[event.feature];
      if (feature === undefined) return withAccount(view, context);
      if (feature.creditRates !== undefined) {
        return withAccount(
          withCreditsOf(view, view.credits, heldOf(view.features) + event.cost),
          context,
        );
      }
      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              reserved: feature.reserved + event.amount,
              remaining: event.remainingAfter,
              allowed: allowsOne(view.standing, feature.overage, event.remainingAfter),
            },
          },
        },
        context,
      );
    },
    // The collocated `UsageRecorded` already applied the usage; this closes the
    // hold and returns whatever it did not bill.
    UsageSettled: (view, event, context): EntitlementsState => {
      const feature = view.features[event.feature];
      if (feature === undefined) return withAccount(view, context);
      if (feature.creditRates !== undefined) {
        return withAccount(
          withCreditsOf(view, view.credits, Math.max(0, heldOf(view.features) - event.cost)),
          context,
        );
      }
      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              // The hold closes in this command, so what it released leaves
              // `reserved` as well as what it billed.
              reserved: Math.max(0, feature.reserved - event.amount - event.released),
              remaining: event.remainingAfter,
              allowed: allowsOne(view.standing, feature.overage, event.remainingAfter),
            },
          },
        },
        context,
      );
    },
    UsageReleased: (view, event, context): EntitlementsState => {
      const feature = view.features[event.feature];
      if (feature === undefined) return withAccount(view, context);
      if (feature.creditRates !== undefined) {
        return withAccount(
          withCreditsOf(view, view.credits, Math.max(0, heldOf(view.features) - event.cost)),
          context,
        );
      }
      return withAccount(
        {
          ...view,
          features: {
            ...view.features,
            [event.feature]: {
              ...feature,
              reserved: Math.max(0, feature.reserved - event.amount),
              remaining: event.remainingAfter,
              allowed: allowsOne(view.standing, feature.overage, event.remainingAfter),
            },
          },
        },
        context,
      );
    },
    PaymentFailed: (view, event, context): EntitlementsState =>
      withAccount(
        { ...view, status: "grace", standing: "grace", dunningAttempts: event.attempt },
        context,
      ),
    GraceEntered: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, status: "grace", standing: "grace" }, context),
    PaymentRecorded: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, status: "active", standing: "good", dunningAttempts: 0 }, context),
    Recovered: (view, _event, context): EntitlementsState =>
      withAccount({ ...view, status: "active", standing: "good", dunningAttempts: 0 }, context),
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
            Object.entries(view.features).map(([feature, value]) => {
              // A credit-priced feature has no allowance to reset: the pool is
              // shared, and only this feature's spend in the period restarts.
              if (value.creditRates !== undefined) {
                return [feature, { ...value, used: 0, reserved: 0 }];
              }
              // `resets: "never"` keeps its usage and open reservations: the
              // boundary moves the period, not this allowance.
              const kept = event.kept?.[feature] === true;
              // An allowance with no count resets to `null` again: usage returns
              // to zero, but an unlimited allowance and a flag still have no
              // number to report.
              const recorded = recordedCount(event.remaining, feature);
              const spendable = recorded === undefined ? includedRemainingOf(value) : recorded;
              return [
                feature,
                {
                  ...value,
                  used: kept ? value.used : 0,
                  reserved: kept ? value.reserved : 0,
                  remaining: spendable,
                  carried: event.carried[feature] ?? 0,
                  allowed: allowsOne(view.standing, value.overage, spendable),
                },
              ];
            }),
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
      withAccount(withPool(view, event.balanceAfter), context),
    CreditsConsumed: (view, event, context): EntitlementsState =>
      withAccount(withPool(view, event.balanceAfter), context),
    CreditsExpired: (view, event, context): EntitlementsState =>
      withAccount(withPool(view, event.balanceAfter), context),
    ProviderRefAttached: (view, _event, context): EntitlementsState => withAccount(view, context),
    // Billing an upgrade moves money, not an entitlement; the view still emits
    // it so the read-model projection sees the whole log.
    ProrationInvoiced: (view, event, context): EntitlementsState =>
      withAccount({ ...view, prorationInvoice: event.invoiceId }, context),
  },
}) {}

/**
 * Move the shared pool, and with it every credit-priced feature's `remaining`.
 * One balance, so the features cannot report different ones.
 */
const withPool = (view: EntitlementsState, balance: number): EntitlementsState =>
  withCreditsOf(view, balance, heldOf(view.features));

/**
 * Whether one more unit is allowed, from the standing and the allowance. Pure,
 * and the same rule `evaluateCheck` applies at `amount: 1`, so the view and
 * `check()` cannot disagree. A `null` remaining is unbounded, so it always has
 * room for one more.
 */
export const allowsOne = (
  standing: Standing,
  overage: Overage,
  remaining: number | null,
): boolean =>
  standing !== "blocked" && (overage !== "block" || remaining === null || remaining >= 1);

/**
 * A feature's spendable count: the outcome an event recorded, or what the
 * allowance has when the event does not mention the feature. `null` is no
 * count at all: an unlimited allowance, or a flag's grant.
 */
const spendableOf = (
  recorded: Readonly<Record<string, number | null>>,
  feature: string,
  allowance: {
    readonly included: Included | null;
    readonly overage: Overage;
    readonly resets: Resets;
  },
): number | null => {
  const remaining = recordedCount(recorded, feature);
  // `undefined` is "this event says nothing about the feature"; `null` is a
  // recorded absence of a count, and must survive as one.
  if (remaining !== undefined) return remaining;
  return includedRemainingOf(allowance);
};

/** The credits open holds keep out of the pool: one number, shared. */
const heldOf = (features: Readonly<Record<string, FeatureEntitlement>>): number => {
  for (const value of Object.values(features)) {
    if (value.creditRates !== undefined) return value.reserved;
  }
  return 0;
};

/**
 * A credit-priced feature's read model: the rate card, the shared pool minus
 * what open holds keep out of it, and the holds themselves.
 */
const creditFeatureOf = (
  rates: CreditRates,
  credits: number,
  held: number,
  previous: FeatureEntitlement | undefined,
  standing: Standing,
): FeatureEntitlement => ({
  creditRates: rates,
  included: null,
  used: previous?.used ?? 0,
  // One pool, so every credit-priced feature reports the same held credits.
  reserved: held,
  remaining: credits - held,
  carried: 0,
  // "One more unit" is `check({ amount: 1 })`, which costs the default rate.
  allowed: standing !== "blocked" && credits - held >= creditRateOf(rates, undefined),
  overage: "block",
  resets: "never",
  resetsAt: null,
});

/**
 * Move the shared pool and its held credits together, so every credit-priced
 * feature keeps reporting one balance.
 */
const withCreditsOf = (
  view: EntitlementsState,
  credits: number,
  held: number,
): EntitlementsState => ({
  ...view,
  credits,
  features: Object.fromEntries(
    Object.entries(view.features).map(([feature, value]) =>
      value.creditRates === undefined
        ? [feature, value]
        : [feature, creditFeatureOf(value.creditRates, credits, held, value, view.standing)],
    ),
  ),
});

const featuresOf = (
  allowances: Readonly<
    Record<string, { kind?: AllowanceKind; included: Included; overage: Overage; resets: Resets }>
  >,
  rates: Readonly<Record<string, CreditRates>>,
  credits: number,
  held: number,
  previous: Readonly<Record<string, FeatureEntitlement>>,
  remaining: Readonly<Record<string, number | null>>,
  periodEnd: DateTime.Utc,
  standing: Standing,
  keepUsage = false,
): Record<string, FeatureEntitlement> => ({
  ...Object.fromEntries(
    Object.entries(allowances).map(([feature, allowance]) => {
      const used = keepUsage ? (previous[feature]?.used ?? 0) : 0;
      const reserved = keepUsage ? (previous[feature]?.reserved ?? 0) : 0;
      const spendable = spendableOf(remaining, feature, allowance);
      return [
        feature,
        {
          ...(allowance.kind === undefined ? {} : { kind: allowance.kind }),
          included: allowance.included,
          used,
          reserved,
          remaining: spendable,
          // A period starts with no rollover; only `UsageReset` carries one in.
          carried: 0,
          allowed: allowsOne(standing, allowance.overage, spendable),
          overage: allowance.overage,
          resets: allowance.resets,
          resetsAt: allowance.resets === "never" ? null : periodEnd,
        },
      ];
    }),
  ),
  // A credit-priced feature has no allowance, so it is not in the map above:
  // its read model is the rate card and the one pool every such feature shares.
  ...Object.fromEntries(
    Object.entries(rates).map(([feature, card]) => [
      feature,
      creditFeatureOf(card, credits, held, previous[feature], standing),
    ]),
  ),
});
