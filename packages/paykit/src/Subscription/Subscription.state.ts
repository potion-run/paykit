import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  Allowances,
  isFlagGrant,
  type Allowance,
  type Included,
  type Overage,
  type UnitPrice,
} from "../Allowance.ts";
import { CreditRateCards, type CreditRates } from "../Feature.ts";
import { Proration } from "../Proration.ts";
import { CreditsExpire, Interval, Price } from "../Tier.ts";

/** An account is the key of a Subscription. */
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

/** Where a subscription is in its life. `none` only exists before activation. */
export const SubscriptionStatus = Schema.Literals([
  "trialing",
  "active",
  "grace",
  "canceled",
  "expired",
]);
export type SubscriptionStatus = typeof SubscriptionStatus.Type;

/** How a reader should treat the account right now. */
export const Standing = Schema.Literals(["good", "grace", "blocked"]);
export type Standing = typeof Standing.Type;

/** `[start, end)` from the account's anchor and time zone. */
export const Period = Schema.Struct({
  start: Schema.DateTimeUtc,
  end: Schema.DateTimeUtc,
  anchorTz: Schema.String,
});
export type Period = typeof Period.Type;

/** A vendor's opaque ids for one account. Never read by `decide`. */
export const ProviderRefs = Schema.Struct({
  customer: Schema.optional(Schema.String),
  subscription: Schema.optional(Schema.String),
  checkout: Schema.optional(Schema.String),
});
export type ProviderRefs = typeof ProviderRefs.Type;

/** Vendor identifiers, keyed by provider, so a second provider is additive. */
export const Refs = Schema.Record(Schema.String, ProviderRefs);
export type Refs = typeof Refs.Type;

/** Per-feature usage, always a fold of `UsageRecorded`. */
export const UsageCounts = Schema.Record(Schema.String, Schema.Int);
export type UsageCounts = typeof UsageCounts.Type;

/**
 * Per-feature remaining allowance, copied from the event that changed it.
 * `null` means there is no count: an unlimited allowance, or a flag's grant. A
 * flag reports the absence of a number rather than one it never spends.
 */
export const Remaining = Schema.Record(Schema.String, Schema.NullOr(Schema.Int));
export type Remaining = typeof Remaining.Type;

/** Where a hold is in its life. A closed hold stays only as an audit record. */
export const HoldStatus = Schema.Literals(["open", "settled", "released"]);
export type HoldStatus = typeof HoldStatus.Type;

/**
 * One hold: the units it keeps out of `remaining`, the dimension it was priced
 * at, and the rate it was priced at, so a catalog change mid-flight does not
 * reprice work already in flight.
 */
export const HoldRecord = Schema.Struct({
  id: Schema.String,
  feature: Schema.String,
  amount: Schema.Int,
  dimension: Schema.optionalKey(Schema.String),
  /** Credits one unit cost when the hold was taken; `0` for a counted feature. */
  rate: Schema.Int,
  /** The credits this hold keeps out of the pool: `amount × rate`. */
  cost: Schema.Int,
  at: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  status: HoldStatus,
});
export type HoldRecord = typeof HoldRecord.Type;

/** Every hold this standing has taken, keyed by id. */
export const Holds = Schema.Record(Schema.String, HoldRecord);
export type Holds = typeof Holds.Type;

/**
 * What an account with no standing looks like: it may still hold checkout refs,
 * and a one-off pack may already have put credits in its pool.
 */
export const UnsubscribedState = Schema.TaggedStruct("Unsubscribed", {
  refs: Refs,
  /** Credits a one-off pack bought before any plan existed. */
  credits: Schema.optionalKey(Schema.Int),
  /** The part of that pool a pack bought; with no plan, all of it. */
  prepaidCredits: Schema.optionalKey(Schema.Int),
  /** The catalog's rate cards, captured by a purchase before any plan. */
  rates: Schema.optionalKey(CreditRateCards),
  /** Per-feature usage, a fold of `UsageRecorded` even without a plan. */
  usage: Schema.optionalKey(UsageCounts),
  /** Per-feature spendable count, copied from the event that changed it. */
  remaining: Schema.optionalKey(Remaining),
  /** Usage keys already recorded, so a retry records once. */
  dedupeKeys: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
});
export type UnsubscribedState = typeof UnsubscribedState.Type;

/** What an account that has ever had a tier looks like. */
export const SubscribedState = Schema.TaggedStruct("Subscribed", {
  tier: Schema.String,
  status: SubscriptionStatus,
  period: Period,
  interval: Interval,
  /** What the tier cost when this standing took it. Absent on a free tier. */
  price: Schema.optionalKey(Price),
  /**
   * The money the last tier change moved, copied from its event. A positive
   * `due` is what `ChargeProration` bills; a negative one is a credit recorded
   * for audit and applied by the next period rather than paid out.
   */
  proration: Schema.optionalKey(Proration),
  /** The provider invoice a proration was billed on, so it bills once. */
  prorationInvoice: Schema.optionalKey(Schema.String),
  trialEndsAt: Schema.optional(Schema.DateTimeUtc),
  graceUntil: Schema.optional(Schema.DateTimeUtc),
  cancelAtPeriodEnd: Schema.Boolean,
  /** The account's credit pool, shared by every credit-priced feature. */
  credits: Schema.Int,
  /**
   * The part of `credits` a one-off pack bought. It never expires, however the
   * standing's plan says its own credits do, so `0 <= prepaidCredits <= credits`
   * and a period close returns only the difference.
   */
  prepaidCredits: Schema.optionalKey(Schema.Int),
  /** Whether the plan's own credits expire at a period close. */
  creditsExpire: CreditsExpire,
  /** Every credit-priced feature's rate card, copied from the event that set it. */
  rates: CreditRateCards,
  currency: Schema.optional(Schema.String),
  usage: UsageCounts,
  /**
   * Money billed this period, per feature, in the standing's currency. A fold
   * of `UsageRecorded.charge`, reset by `UsageReset`; never a second counter.
   */
  billed: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
  remaining: Remaining,
  /** Every hold, open or closed. `reserved` and `reservedCredits` fold this. */
  holds: Holds,
  allowances: Allowances,
  refs: Refs,
  trialUsed: Schema.Boolean,
  dedupeKeys: Schema.Record(Schema.String, Schema.Boolean),
  dunningAttempts: Schema.Int,
  lastClosedPeriodStart: Schema.optional(Schema.DateTimeUtc),
});
export type SubscribedState = typeof SubscribedState.Type;

/** One aggregate, keyed by account, that decides every billing command. */
export const SubscriptionState = Schema.Union([UnsubscribedState, SubscribedState]);
export type SubscriptionState = typeof SubscriptionState.Type;

/** The state an account starts in: no tier, no standing. */
export const initialSubscriptionState: SubscriptionState = { _tag: "Unsubscribed", refs: {} };

/** A subscription's status, or `none` before the first activation. */
export const statusOf = (state: SubscriptionState): SubscriptionStatus | "none" =>
  state._tag === "Subscribed" ? state.status : "none";

/** Map a status to what a caller may do with it. */
export const standingOf = (status: SubscriptionStatus | "none"): Standing => {
  switch (status) {
    case "trialing":
    case "active":
      return "good";
    case "grace":
      return "grace";
    case "canceled":
    case "expired":
    case "none":
      return "blocked";
  }
};

/** Whether `Track` may record usage in this status. Grace keeps service on. */
export const allowsUsage = (status: SubscriptionStatus | "none"): boolean =>
  status === "trialing" || status === "active" || status === "grace";

/** Whether a status has ended. A terminal standing opens no further periods. */
export const isTerminalStatus = (status: SubscriptionStatus): boolean =>
  status === "canceled" || status === "expired";

/** Whether a period may roll from this status. Terminal standings do not. */
export const rollsPeriod = (status: SubscriptionStatus): boolean => !isTerminalStatus(status);

/** Whether an operator may move this status into grace. */
export const canEnterGrace = (status: SubscriptionStatus): boolean =>
  status === "trialing" || status === "active";

/** When an allowance next resets, or `null` for one that never does. */
export const resetsAt = (period: Period, allowance: Allowance): DateTime.Utc | null =>
  allowance.resets === "never" ? null : period.end;

/** Add one calendar month or year, keeping the account's anchor. */
export const addInterval = (at: DateTime.Utc, interval: Interval): DateTime.Utc =>
  DateTime.add(at, interval === "month" ? { months: 1 } : { years: 1 });

/** Start a period at `start` for the cadence the tier was bought with. */
export const periodFrom = (start: DateTime.Utc, interval: Interval, anchorTz = "UTC"): Period => ({
  start,
  end: addInterval(start, interval),
  anchorTz,
});

/** Sum of a feature's usage. */
export const usedOf = (state: SubscribedState, feature: string): number =>
  state.usage[feature] ?? 0;

/** Money already billed for one feature this period, or `0`. */
export const billedOf = (state: SubscribedState, feature: string): number =>
  state.billed?.[feature] ?? 0;

/**
 * The part of one usage event that is past `included`, and so billable. An
 * allowance with no count — unlimited, or a flag — has nothing billable.
 */
export const billableUnitsOf = (
  included: number | "unlimited" | null,
  used: number,
  amount: number,
): number => {
  if (typeof included !== "number") return 0;
  const before = Math.max(0, used - included);
  const after = Math.max(0, used + amount - included);
  return after - before;
};

/** The money one usage event bills: billable units × the unit price. */
export const chargeOf = (
  unitPrice: UnitPrice | undefined,
  included: number | "unlimited" | null,
  used: number,
  amount: number,
): number =>
  unitPrice === undefined ? 0 : billableUnitsOf(included, used, amount) * unitPrice.amount;

/**
 * A per-feature count as it was recorded: `undefined` when the record does not
 * mention the feature at all, which is not the same as a recorded `null`.
 */
export const recordedCount = (
  counts: Readonly<Record<string, number | null>>,
  feature: string,
): number | null | undefined => (Object.hasOwn(counts, feature) ? counts[feature] : undefined);

/**
 * The spendable count an allowance starts a period with: what it includes, or
 * `null` when there is no count — an unlimited allowance, or a flag's grant.
 */
export const includedRemainingOf = (allowance: {
  readonly kind?: "metered" | "flag";
  readonly included: Included | null;
}): number | null =>
  allowance.included === null || allowance.included === "unlimited" || isFlagGrant(allowance)
    ? null
    : allowance.included;

/**
 * A spendable count after spending `amount` of it. An unbounded count has
 * nothing to spend down, so it stays `null` however much is used.
 */
export const remainingAfterSpending = (remaining: number | null, amount: number): number | null =>
  remaining === null ? null : remaining - amount;

/**
 * A spendable count after releasing `amount` back into it. An unbounded count
 * stays `null`.
 */
export const remainingAfterRelease = (remaining: number | null, amount: number): number | null =>
  remaining === null ? null : remaining + amount;

/**
 * A feature's spendable amount, defaulting to what the tier included.
 * `remaining` is already net of open reservations, so this is what a caller
 * may take right now, and `null` means there is no limit to take from.
 */
export const remainingOf = (state: SubscribedState, feature: string): number | null => {
  const remaining = recordedCount(state.remaining, feature);
  if (remaining !== undefined) return remaining;
  const allowance = state.allowances[feature];
  return allowance === undefined ? 0 : includedRemainingOf(allowance);
};

/**
 * What an allowance's next period starts with, and how much of that carried.
 * A period starts at `included` plus what the closing one did not spend,
 * clamped to `[0, included]` so a period never holds more than two periods'
 * worth and an overdrawn allowance never deducts from the next one. An
 * allowance that does not carry starts at `included`; one with no count — an
 * unlimited allowance, or a flag — has nothing to carry.
 *
 * `resets: "never"` is the one status a period boundary does not move: the
 * feature keeps its usage, open holds and remaining count, and `kept` says so.
 * A monthly or annual reset both happen at the standing's period boundary,
 * because that is the only boundary the aggregate owns.
 */
export const resetOf = (
  state: SubscribedState,
  feature: string,
  allowance: Allowance,
): { readonly remaining: number | null; readonly carried: number; readonly kept: boolean } => {
  const start = includedRemainingOf(allowance);
  if (start === null) return { remaining: null, carried: 0, kept: false };
  if (allowance.resets === "never") {
    return { remaining: remainingOf(state, feature), carried: 0, kept: true };
  }
  if (allowance.carryOver !== true) return { remaining: start, carried: 0, kept: false };
  const carried = Math.min(Math.max(remainingOf(state, feature) ?? 0, 0), start);
  return { remaining: start + carried, carried, kept: false };
};

/**
 * The credits one unit of a credit-priced feature costs at `dimension`, or at
 * `"default"` when the caller names none. A dimension the card does not price
 * falls back to `"default"`: the catalog requires it, so every unit has a
 * price.
 */
export const creditRateOf = (rates: CreditRates, dimension: string | undefined): number =>
  rates[dimension ?? "default"] ?? rates["default"] ?? 0;

/**
 * The most units a period may bill for a feature: `included + cap`, or `null`
 * when the allowance states no cap. A cap only exists where billing does, so an
 * allowance that is not billed past `included` has no ceiling to compute.
 */
export const spendCeilingOf = (allowance: {
  readonly included: Included | null;
  readonly overage: Overage;
  readonly cap?: number;
}): number | null =>
  allowance.cap === undefined || allowance.included === null || allowance.included === "unlimited"
    ? null
    : allowance.included + allowance.cap;

/**
 * The units this period may still bill before the cap: `included + cap − used −
 * reserved`. Written from `remaining`, `carried` and `cap` because that is what
 * a read model carries: `remaining` already has use and holds taken out, and
 * `carried` is the extra `included` a rollover added, which a cap does not.
 */
export const spendHeadroomOf = (feature: {
  readonly remaining: number | null;
  readonly carried?: number;
  readonly cap?: number;
}): number | null =>
  feature.cap === undefined || feature.remaining === null
    ? null
    : feature.remaining + feature.cap - (feature.carried ?? 0);

/** The pool a standing actually holds, for a state that may predate the field. */
export const creditsOf = (state: SubscriptionState): number =>
  state._tag === "Subscribed" ? state.credits : (state.credits ?? 0);

/** The part of the pool a one-off pack bought, on either kind of state. */
export const prepaidCreditsOf = (state: SubscriptionState): number => state.prepaidCredits ?? 0;

/**
 * The credits a period close may expire: the plan's own credits, never the part
 * a one-off pack bought. A pool that never expires has nothing to return.
 */
export const expiringCreditsOf = (state: SubscribedState): number =>
  state.creditsExpire === "never" ? 0 : state.credits - prepaidCreditsOf(state);

/**
 * The protected portion after the balance moved down. Expiring credits are
 * spent first, so a purchase is only touched once the plan's credits are gone.
 */
export const protectedAfterSpending = (state: SubscribedState, balanceAfter: number): number =>
  Math.max(0, Math.min(prepaidCreditsOf(state), balanceAfter));

/** The holds that are still waiting to settle or release. */
export const openHoldsOf = (state: SubscribedState): ReadonlyArray<HoldRecord> =>
  Object.values(state.holds).filter((hold) => hold.status === "open");

/**
 * The units open holds keep out of one feature's `remaining`. Derived from the
 * holds themselves, so two concurrent holds on one feature stay addressable
 * and a replay reproduces the number.
 */
export const reservedOf = (state: SubscribedState, feature: string): number =>
  openHoldsOf(state)
    .filter((hold) => hold.feature === feature)
    .reduce((sum, hold) => sum + hold.amount, 0);

/** The credits open holds keep out of the pool, across every credit feature. */
export const reservedCreditsOf = (state: SubscribedState): number =>
  openHoldsOf(state).reduce((sum, hold) => sum + hold.cost, 0);

/**
 * What a caller may spend of a feature right now: its counted `remaining`, or
 * the pool minus what open holds have taken out of it.
 */
export const availableOf = (state: SubscribedState, feature: string): number | null =>
  state.rates[feature] === undefined
    ? remainingOf(state, feature)
    : state.credits - reservedCreditsOf(state);

/** A hold by id, or `null` when this standing never took one. */
export const holdOf = (state: SubscribedState, holdId: string): HoldRecord | null =>
  state.holds[holdId] ?? null;

/** The same hold, no longer open. */
export const closingHold = (hold: HoldRecord, status: HoldStatus): HoldRecord => ({
  ...hold,
  status,
});

/** The tick a money plane thinks in: integer minor units and a currency. */
export const Money = Schema.Struct({
  amount: Schema.Int,
  currency: Schema.String,
});
export type Money = typeof Money.Type;

/** Every event tag the Subscription aggregate can record. */
export const SUBSCRIPTION_EVENT_TAGS = [
  "TrialStarted",
  "TrialExtended",
  "SubscriptionActivated",
  "TierChanged",
  "UsageRecorded",
  "UsageReserved",
  "UsageSettled",
  "UsageReleased",
  "PaymentRecorded",
  "PaymentFailed",
  "GraceEntered",
  "Recovered",
  "CreditsGranted",
  "CreditsPurchased",
  "CreditsConsumed",
  "CancellationScheduled",
  "CancellationWithdrawn",
  "PeriodClosed",
  "UsageReset",
  "CreditsExpired",
  "SubscriptionExpired",
  "ProviderRefAttached",
] as const;
