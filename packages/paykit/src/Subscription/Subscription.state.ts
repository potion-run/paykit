import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Allowances, isFlagGrant, type Allowance, type Included } from "../Allowance.ts";
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

/** What an account with no standing looks like: it may still hold checkout refs. */
export const UnsubscribedState = Schema.TaggedStruct("Unsubscribed", { refs: Refs });
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
  /** Whether that pool expires at a period close. */
  creditsExpire: CreditsExpire,
  /** Every credit-priced feature's rate card, copied from the event that set it. */
  rates: CreditRateCards,
  currency: Schema.optional(Schema.String),
  usage: UsageCounts,
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
 */
export const resetOf = (
  state: SubscribedState,
  feature: string,
  allowance: Allowance,
): { readonly remaining: number | null; readonly carried: number } => {
  const start = includedRemainingOf(allowance);
  if (start === null) return { remaining: null, carried: 0 };
  if (allowance.carryOver !== true) return { remaining: start, carried: 0 };
  const carried = Math.min(Math.max(remainingOf(state, feature) ?? 0, 0), start);
  return { remaining: start + carried, carried };
};

/**
 * The credits one unit of a credit-priced feature costs at `dimension`, or at
 * `"default"` when the caller names none. A dimension the card does not price
 * falls back to `"default"`: the catalog requires it, so every unit has a
 * price.
 */
export const creditRateOf = (rates: CreditRates, dimension: string | undefined): number =>
  rates[dimension ?? "default"] ?? rates["default"] ?? 0;

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
  "CreditsConsumed",
  "CancellationScheduled",
  "CancellationWithdrawn",
  "PeriodClosed",
  "UsageReset",
  "CreditsExpired",
  "SubscriptionExpired",
  "ProviderRefAttached",
] as const;
