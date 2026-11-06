import type * as DateTime from "effect/DateTime";
import { isQuantityGrant, pricingOf, type Allowances } from "../Allowance.ts";
import type { CreditRateCards } from "../Feature.ts";
import { currencyOfPricing } from "../Pricing.ts";
import type { CreditsExpire, Interval, Price, TopUpThreshold } from "../Tier.ts";
import {
  includedRemainingOf,
  nextResetAt,
  periodTiedReset,
  prepaidCreditsOf,
  quantityAfterTierChange,
  type Period,
  type QuantityCounts,
  type SubscribedState,
  type SubscriptionState,
  type SubscriptionStatus,
} from "./Subscription.state.ts";

/**
 * One standing, one construction.
 *
 * An event that opens a standing — `TrialStarted` or `SubscriptionActivated` —
 * carries the same grant: the tier, its allowances, the pool, the period and the
 * terms the catalog sold. `activationOf` builds that payload from the terms a
 * command carries, and `standingFrom` folds it into the state. They are the only
 * place the field list lives, so adding a field to a standing is one edit, and
 * an optional field's fallback (`currency`, `prepaidCredits`, `interval`) is
 * decided once instead of once per constructor.
 *
 * Both are pure: the event is already schema-validated, and `decide` never reads
 * a catalog, so there is nothing to decode here and no failure to carry.
 *
 */

/**
 * The currency a tier's postpaid prices are stated in, if it has any. A tier
 * states one currency for both its plan price and its unit prices, so the first
 * unit price answers for the standing.
 */
export const unitPriceCurrencyOf = (allowances: Allowances): string | undefined => {
  for (const allowance of Object.values(allowances)) {
    const pricing = pricingOf(allowance);
    if (pricing !== null) return currencyOfPricing(pricing);
  }
  return undefined;
};

/**
 * The spendable count every allowance starts a period with. A count is
 * `included`; an allowance with no count — unlimited, or a flag — starts at
 * `null`, which is the absence of a count rather than zero.
 */
/** The quantity every non-consumable allowance starts with: its free grant. */
export const startingQuantities = (allowances: Allowances): QuantityCounts =>
  Object.fromEntries(
    Object.entries(allowances).flatMap(([feature, allowance]) =>
      isQuantityGrant(allowance) && typeof allowance.included === "number"
        ? [[feature, allowance.included]]
        : [],
    ),
  );

/**
 * The spendable count every allowance starts a period with. A non-consumable
 * feature is not a counter: a tier change keeps the quantity the account holds
 * (or raises it to the new free grant), so its remaining is the new cap less
 * that quantity. An activation passes no quantities, and starts at the grant.
 */
export const startingRemaining = (
  allowances: Allowances,
  quantities: QuantityCounts = {},
): Record<string, number | null> =>
  Object.fromEntries(
    Object.entries(allowances).map(([feature, allowance]) => {
      if (isQuantityGrant(allowance)) {
        const included = typeof allowance.included === "number" ? allowance.included : 0;
        const quantity = quantityAfterTierChange(quantities[feature] ?? included, included);
        return [
          feature,
          allowance.cap === undefined ? null : Math.max(0, allowance.cap - quantity),
        ];
      }
      return [feature, includedRemainingOf(allowance)];
    }),
  );

/**
 * The part of a pool a one-off pack already bought, omitted when there is none
 * so an event for an ordinary plan does not grow a zero field.
 */
export const carriedPrepaidOf = (
  state: SubscriptionState,
  credits: number,
): { readonly prepaidCredits?: number } => {
  const prepaid = Math.min(prepaidCreditsOf(state), credits);
  return prepaid === 0 ? {} : { prepaidCredits: prepaid };
};

/** The terms an activation records, as a command carries them. */
export interface ActivationInput<S extends SubscriptionStatus = SubscriptionStatus> {
  readonly tier: string;
  readonly allowances: Allowances;
  /** The whole pool the event records: the grant plus any pack carried in. */
  readonly credits: number;
  /** The part of that pool a pack bought; clamped to `credits`. */
  readonly prepaidCredits?: number;
  readonly creditsExpire: CreditsExpire;
  readonly topUp?: TopUpThreshold;
  readonly rates: CreditRateCards;
  readonly price?: Price;
  /** The period the activation opens. */
  readonly period: Period;
  /**
   * The currency the standing already had. A tier with no price and no unit
   * prices inherits it rather than dropping it.
   */
  readonly previousCurrency?: string;
  readonly statusAfter: S;
}

/**
 * The first boundary of every allowance that runs on its own schedule, keyed by
 * feature. A monthly or annual allowance is the standing's period and gets no
 * entry; a daily or quarterly one starts a window at `from`.
 */
export const resetWindowsOf = (
  allowances: Allowances,
  from: DateTime.Utc,
): Record<string, DateTime.Utc> =>
  Object.fromEntries(
    Object.entries(allowances).flatMap(([feature, allowance]) => {
      if (allowance.resets === "never" || periodTiedReset(allowance)) return [];
      const at = nextResetAt(from, allowance);
      return at === null ? [] : [[feature, at]];
    }),
  );

/** The fields an activation event records, in the shape both events share. */
export interface ActivationGrant<S extends SubscriptionStatus = SubscriptionStatus> {
  readonly tier: string;
  readonly allowances: Allowances;
  readonly remaining: Record<string, number | null>;
  readonly credits: number;
  readonly prepaidCredits?: number;
  readonly creditsExpire: CreditsExpire;
  readonly topUp?: TopUpThreshold;
  readonly rates: CreditRateCards;
  readonly periodStart: DateTime.Utc;
  readonly periodEnd: DateTime.Utc;
  readonly anchorTz: string;
  readonly currency?: string;
  readonly price?: Price;
  /** The first boundary of every allowance that runs on its own schedule. */
  readonly resetAt?: Record<string, DateTime.Utc>;
  readonly statusAfter: S;
}

/**
 * The payload an activation records.
 *
 * The event carries the catalog terms because `decide` is pure and a replay must
 * not read a catalog. The optional fields are resolved here — a zero pack part
 * is omitted, the currency falls back to what the standing already had — so
 * `StartTrial` and `Subscribe` cannot disagree about what an activation says.
 *
 * ### One activation payload
 * **Example:** A trial's grant, from the terms the command carries
 * ```typescript
 * activationOf({
 *   tier: "pro",
 *   allowances,
 *   credits: 5_000,
 *   prepaidCredits: 1_000,
 *   creditsExpire: "period",
 *   rates: {},
 *   period: { start, end: trialEnd, anchorTz: "UTC" },
 *   previousCurrency: "usd",
 *   statusAfter: "trialing",
 * });
 * // { tier: "pro", credits: 5_000, prepaidCredits: 1_000, currency: "usd", ... }
 * ```
 *
 */
export const activationOf = <S extends SubscriptionStatus>(
  input: ActivationInput<S>,
): ActivationGrant<S> => {
  const prepaid = Math.min(input.prepaidCredits ?? 0, input.credits);
  const currency =
    input.price?.currency ?? unitPriceCurrencyOf(input.allowances) ?? input.previousCurrency;
  const resetAt = resetWindowsOf(input.allowances, input.period.start);
  return {
    tier: input.tier,
    allowances: input.allowances,
    remaining: startingRemaining(input.allowances),
    credits: input.credits,
    ...(prepaid === 0 ? {} : { prepaidCredits: prepaid }),
    creditsExpire: input.creditsExpire,
    ...(input.topUp === undefined ? {} : { topUp: input.topUp }),
    rates: input.rates,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    anchorTz: input.period.anchorTz,
    ...(currency === undefined ? {} : { currency }),
    ...(input.price === undefined ? {} : { price: input.price }),
    ...(Object.keys(resetAt).length === 0 ? {} : { resetAt }),
    statusAfter: input.statusAfter,
  } satisfies ActivationGrant<S>;
};

/**
 * Everything an event that opens a standing carries. The two activation events
 * differ only in their extras: a trial states its deadline, an activation its
 * cadence.
 */
export interface StandingGrant {
  readonly tier: string;
  readonly allowances: Allowances;
  readonly remaining: Record<string, number | null>;
  readonly credits: number;
  readonly prepaidCredits?: number;
  readonly creditsExpire: CreditsExpire;
  readonly topUp?: TopUpThreshold;
  readonly rates: CreditRateCards;
  readonly periodStart: DateTime.Utc;
  readonly periodEnd: DateTime.Utc;
  readonly anchorTz: string;
  /** The cadence the tier was bought with; absent on a trial event. */
  readonly interval?: Interval;
  readonly currency?: string;
  readonly price?: Price;
  /** The next boundary of every allowance that runs on its own schedule. */
  readonly resetAt?: Record<string, DateTime.Utc>;
  readonly statusAfter: SubscriptionStatus;
  /** The trial's deadline; absent on an activation. */
  readonly trialEndsAt?: DateTime.Utc;
}

/**
 * The standing an activation leaves behind.
 *
 * One construction for both activation events. Everything a fresh standing
 * resets is named here and nowhere else: the counters, holds, dedupe keys and
 * dunning attempts start empty, the pool and every allowance come from the
 * grant, and the references and the trial flag are the two facts carried over
 * from what the account already had.
 *
 * ### Folding an activation
 * **Example:** The state a trial event leaves
 * ```typescript
 * standingFrom(
 *   {
 *     tier: "pro",
 *     allowances,
 *     remaining: { messages: 2_000 },
 *     credits: 5_000,
 *     creditsExpire: "period",
 *     rates: {},
 *     periodStart: start,
 *     periodEnd: end,
 *     anchorTz: "UTC",
 *     statusAfter: "trialing",
 *     trialEndsAt: end,
 *   },
 *   initialSubscriptionState,
 *   { trialUsed: true },
 * );
 * ```
 *
 */
export const standingFrom = (
  grant: StandingGrant,
  previous: SubscriptionState,
  options: { readonly trialUsed: boolean },
): SubscribedState =>
  ({
    _tag: "Subscribed",
    tier: grant.tier,
    status: grant.statusAfter,
    period: {
      start: grant.periodStart,
      end: grant.periodEnd,
      anchorTz: grant.anchorTz,
    },
    interval: grant.interval ?? grant.price?.interval ?? "month",
    cancelAtPeriodEnd: false,
    credits: grant.credits,
    prepaidCredits: grant.prepaidCredits ?? 0,
    creditsExpire: grant.creditsExpire,
    ...(grant.topUp === undefined ? {} : { topUp: grant.topUp }),
    rates: grant.rates,
    // A trial event has no interval and an activation always does; a tier with
    // no price and no unit prices keeps the currency the account already had.
    ...(grant.currency === undefined
      ? previous._tag === "Subscribed" && previous.currency !== undefined
        ? { currency: previous.currency }
        : {}
      : { currency: grant.currency }),
    ...(grant.price === undefined ? {} : { price: grant.price }),
    ...(grant.resetAt === undefined ? {} : { resetAt: grant.resetAt }),
    ...(grant.trialEndsAt === undefined ? {} : { trialEndsAt: grant.trialEndsAt }),
    usage: {},
    remaining: grant.remaining,
    holds: {},
    allowances: grant.allowances,
    quantities: startingQuantities(grant.allowances),
    refs: previous.refs,
    trialUsed: options.trialUsed,
    dedupeKeys: {},
    dunningAttempts: 0,
  }) satisfies SubscribedState;
