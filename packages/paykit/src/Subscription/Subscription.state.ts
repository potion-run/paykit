import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  Allowances,
  carryCapOf,
  isFlagGrant,
  isQuantityGrant,
  type Allowance,
  type AllowanceKind,
  type Included,
  type Overage,
  type Pricing,
  type Resets,
} from "../Allowance.ts";
import { CreditRateCards } from "../Feature.ts";
import { chargeOfPricing, pricedLines, type PricedLine } from "../Pricing.ts";
import { Proration } from "../Proration.ts";
import { CreditsExpire, Interval, Price, TopUpTerms } from "../Tier.ts";

export { creditRateOf } from "../Feature.ts";

/**
 * Money recorded per currency, in minor units. `charged` folds what paykit
 * recorded as billed and paid; `refunded` folds what went back. A map rather
 * than one number because an account may have been sold in one currency and
 * billed in another (ADR 0019).
 */
export const MoneyByCurrency = Schema.Record(Schema.String, Schema.Int);
export type MoneyByCurrency = typeof MoneyByCurrency.Type;

/**
 * One refund, keyed by the operator command that recorded it. The key is what
 * makes a retried refund a replay rather than a second request against a
 * ceiling the first one already spent (ADR 0019).
 */
export const RefundRecord = Schema.Struct({
  refundId: Schema.String,
  amount: Schema.Int,
  currency: Schema.String,
  /** The currency's refunded total after this refund. */
  refundedAfter: Schema.Int,
});
export type RefundRecord = typeof RefundRecord.Type;

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
 * The current quantity of every non-consumable feature. A seat is set, not
 * spent, so this is the quantity the account holds — not a counter a period
 * close resets.
 */
export const QuantityCounts = Schema.Record(Schema.String, Schema.Int);
export type QuantityCounts = typeof QuantityCounts.Type;

/** A quantity change's money, keyed by the command that recorded it. */
export const QuantityProration = Schema.Struct({
  feature: Schema.String,
  proration: Proration,
  /** The provider invoice that collected a positive `due`. */
  invoiceId: Schema.optionalKey(Schema.String),
});
export type QuantityProration = typeof QuantityProration.Type;

/**
 * Per-feature remaining allowance, copied from the event that changed it.
 * `null` means there is no count: an unlimited allowance, or a flag's grant. A
 * flag reports the absence of a number rather than one it never spends.
 */
export const Remaining = Schema.Record(Schema.String, Schema.NullOr(Schema.Int));
export type Remaining = typeof Remaining.Type;

/**
 * The next boundary of every allowance that runs on its own schedule, keyed by
 * feature. A monthly or annual allowance is the standing's period and needs no
 * entry; a daily or quarterly one has a boundary the period does not own.
 */
export const ResetWindows = Schema.Record(Schema.String, Schema.DateTimeUtc);
export type ResetWindows = typeof ResetWindows.Type;

/**
 * Where a hold is in its life. A closed hold stays only as an audit record.
 * `expired` is a sweep or a clock past the deadline; `released` is a caller or
 * a period close returning the units.
 */
export const HoldStatus = Schema.Literals(["open", "settled", "released", "expired"]);
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

/**
 * The tier the standing moves to when the current period closes, with the terms
 * it carries. The event records them because the close runs without a catalog:
 * the standing has to hold everything the boundary needs, the same way
 * `SubscriptionActivated` does.
 */
export const PendingTier = Schema.Struct({
  tier: Schema.String,
  allowances: Allowances,
  price: Schema.optionalKey(Price),
  /** The pool the standing keeps; a change is not a grant. */
  credits: Schema.Int,
  creditsExpire: CreditsExpire,
  /** Credits at or below which the new tier's spends buy the deployment's pack. */
  topUp: Schema.optionalKey(TopUpTerms),
  rates: CreditRateCards,
  currency: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Interval),
});
export type PendingTier = typeof PendingTier.Type;

/** Every hold this standing has taken, keyed by id. */
export const Holds = Schema.Record(Schema.String, HoldRecord);
export type Holds = typeof Holds.Type;

/**
 * The last auto top-up a standing could not buy: what was wanted, who refused
 * it, and when. It is the standing's copy of a `TopUpFailed` event, so a page
 * answers "why is this pool still low" without folding the account's log.
 */
export const TopUpFailureRecord = Schema.Struct({
  /** The `kind: "one_off"` pack the tier's line named. */
  tier: Schema.String,
  /** What the pack would have cost. */
  price: Schema.optionalKey(Price),
  /** The provider that refused, or `"none"` when the account had none. */
  provider: Schema.String,
  /** The refusal's tag, for an operator to match. */
  reason: Schema.String,
  /** When the crossing gave up. */
  at: Schema.DateTimeUtc,
});
export type TopUpFailureRecord = typeof TopUpFailureRecord.Type;

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
  /** Money this account was charged, per currency, as the log records it. */
  charged: Schema.optionalKey(MoneyByCurrency),
  /** Money that went back, per currency. A refund is capped by `charged`. */
  refunded: Schema.optionalKey(MoneyByCurrency),
  /** Every refund, keyed by the operator command that recorded it. */
  refunds: Schema.optionalKey(Schema.Record(Schema.String, RefundRecord)),
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
  /**
   * A stable id for the current `proration`, derived from how many prorations
   * this standing has recorded. `ChargeProration` uses it as the idempotency
   * key, so a retry is the same invoice. Absent when the current change moved
   * no money.
   */
  prorationId: Schema.optionalKey(Schema.String),
  /** How many prorated tier changes this standing has recorded. */
  prorationSeq: Schema.optionalKey(Schema.Int),
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
  /**
   * Credits at or below which a spend buys the deployment's auto top-up pack.
   * Absent means this tier never refills. It travels on the standing because
   * `decide` is pure and the policy runs without the catalog.
   */
  topUp: Schema.optionalKey(TopUpTerms),
  /**
   * When the last policy-opened top-up's cooldown ends. A crossing while this is
   * set is deferred, not refused: `TopUpCooldownElapsed` clears it at the
   * deadline and the policy re-asks. Absent on a deployment with no cooldown and
   * on a purchase a checkout completed.
   */
  topUpCooldownUntil: Schema.optionalKey(Schema.DateTimeUtc),
  /**
   * The last auto top-up this account's line could not buy. It is cleared by the
   * next successful purchase, so the field answers "is this account short of a
   * refill it was promised" rather than "did a refill ever fail". Absent on an
   * account nothing has failed for (ADR 0026).
   */
  topUpFailure: Schema.optionalKey(TopUpFailureRecord),
  /**
   * Money this account was charged, per currency: a fold of `PaymentRecorded`,
   * `CreditsPurchased.price` and `ProrationInvoiced`. It is the ceiling a
   * refund is measured against (ADR 0019).
   */
  charged: Schema.optionalKey(MoneyByCurrency),
  /** Money that went back, per currency: a fold of `RefundRecorded`. */
  refunded: Schema.optionalKey(MoneyByCurrency),
  /** Every refund, keyed by the operator command that recorded it. */
  refunds: Schema.optionalKey(Schema.Record(Schema.String, RefundRecord)),
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
  /**
   * The next boundary of every allowance that does not follow the standing's
   * period. Absent means the feature resets at `period.end` (or never).
   */
  resetAt: Schema.optionalKey(ResetWindows),
  /** Every hold, open or closed. `reserved` and `reservedCredits` fold this. */
  holds: Holds,
  /**
   * The current quantity of every non-consumable feature. A period close does
   * not reset one: a seat is held until the account sets a different quantity.
   */
  quantities: Schema.optionalKey(QuantityCounts),
  /**
   * The unbilled money a quantity change moved, keyed by the command that
   * recorded it. A positive `due` is collected by `ChargeQuantityProration`;
   * a credit stays here for the next period to apply.
   */
  quantityProrations: Schema.optionalKey(Schema.Record(Schema.String, QuantityProration)),
  allowances: Allowances,
  /**
   * The tier the standing moves to when this period closes, if one was
   * scheduled. A close applies it before the counters reset, so the next period
   * starts on the new tier's allowances.
   */
  pendingTier: Schema.optionalKey(PendingTier),
  refs: Refs,
  trialUsed: Schema.Boolean,
  dedupeKeys: Schema.Record(Schema.String, Schema.Boolean),
  dunningAttempts: Schema.Int,
  /**
   * The failure that started the current dunning run. The retry ladder is
   * measured from here, and a scheduled retry carries the same instant so a
   * leftover schedule cannot charge the next run.
   */
  dunningStartedAt: Schema.optionalKey(Schema.DateTimeUtc),
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

/**
 * Whether an allowance's boundary is the standing's period. Only a monthly or
 * annual allowance with no multiplier is: every other schedule owns a window
 * the period close must not reset.
 */
export const periodTiedReset = (allowance: {
  readonly resets: Resets;
  readonly resetEvery?: number;
}): boolean =>
  (allowance.resets === "month" || allowance.resets === "annual") &&
  (allowance.resetEvery ?? 1) === 1;

/** The boundary after `from` for an allowance's schedule, or `null` for never. */
export const nextResetAt = (
  from: DateTime.Utc,
  allowance: { readonly resets: Resets; readonly resetEvery?: number },
): DateTime.Utc | null => {
  const every = allowance.resetEvery ?? 1;
  switch (allowance.resets) {
    case "never":
      return null;
    case "hour":
      return DateTime.add(from, { hours: every });
    case "day":
      return DateTime.add(from, { days: every });
    case "week":
      return DateTime.add(from, { weeks: every });
    case "month":
      return DateTime.add(from, { months: every });
    case "quarter":
      return DateTime.add(from, { months: 3 * every });
    case "semi_annual":
      return DateTime.add(from, { months: 6 * every });
    case "annual":
      return DateTime.add(from, { years: every });
  }
};

/**
 * The boundary an allowance is waiting for, from the standing's own record.
 * A feature with no entry is period-tied, so the period's end is its boundary.
 */
export const resetAtOf = (
  state: SubscribedState,
  feature: string,
  allowance: Allowance,
): DateTime.Utc | null =>
  allowance.resets === "never" ? null : (state.resetAt?.[feature] ?? state.period.end);

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

/** The auto top-up line this standing holds, or `null` when it never refills. */
export const topUpOf = (state: SubscriptionState): TopUpTerms | null =>
  state._tag === "Subscribed" ? (state.topUp ?? null) : null;

/** The credits at or below which a spend on this standing is a crossing, or `null`. */
export const topUpThresholdOf = (state: SubscriptionState): number | null =>
  topUpOf(state)?.threshold ?? null;

/** The tier this standing is on, or `null` when it never subscribed. */
export const standingTierOf = (state: SubscriptionState): string | null =>
  state._tag === "Subscribed" ? state.tier : null;

/**
 * The last refill this standing could not buy, or `null` when nothing failed or
 * a purchase has since succeeded. A failure is a standing's fact, so an account
 * with no plan has none.
 */
export const topUpFailureOf = (state: SubscriptionState): TopUpFailureRecord | null =>
  state._tag === "Subscribed" ? (state.topUpFailure ?? null) : null;

/**
 * The deadline a top-up cooldown ends at, or `null` when one is not open. Only a
 * standing can carry one: a cooldown is opened by a policy-opened purchase, and
 * a threshold only a tier can state.
 */
export const topUpCooldownOf = (state: SubscriptionState): DateTime.Utc | null =>
  state._tag === "Subscribed" ? (state.topUpCooldownUntil ?? null) : null;

/** The money this account was charged, per currency. Absent folds to nothing. */
export const chargedOf = (state: SubscriptionState): MoneyByCurrency => state.charged ?? {};

/** The money that went back, per currency. Absent folds to nothing. */
export const refundedOf = (state: SubscriptionState): MoneyByCurrency => state.refunded ?? {};

/**
 * What may still go back in one currency: charged minus refunded, never below
 * zero. A currency the account was never charged in has nothing refundable.
 */
export const refundableOf = (state: SubscriptionState, currency: string): number =>
  Math.max(0, (chargedOf(state)[currency] ?? 0) - (refundedOf(state)[currency] ?? 0));

/**
 * The refund one operator command recorded, if it already ran. A retry with the
 * same command id answers this instead of spending ceiling the first attempt
 * already spent.
 */
export const refundOfCommand = (state: SubscriptionState, commandId: string): RefundRecord | null =>
  state.refunds?.[commandId] ?? null;

/** Add a charge to the fold, leaving every other currency alone. */
export const chargedWith = (
  state: Pick<SubscriptionState, "charged">,
  currency: string,
  amount: number,
): MoneyByCurrency => ({
  ...state.charged,
  [currency]: (state.charged?.[currency] ?? 0) + amount,
});

/** Set a currency's refunded total, as the event that recorded it says. */
export const refundedWith = (
  state: Pick<SubscriptionState, "refunded">,
  currency: string,
  total: number,
): MoneyByCurrency => ({ ...state.refunded, [currency]: total });

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

/**
 * The money one usage event bills: the cumulative price of the billable count
 * after it minus the price before it. Written this way, a package price, a
 * graduated ladder and a volume ladder all bill the same event the same way,
 * and the order two events arrive in cannot change the period's total.
 */
export const chargeOf = (
  pricing: Pricing | null | undefined,
  included: number | "unlimited" | null,
  used: number,
  amount: number,
): number => {
  if (pricing === null || pricing === undefined) return 0;
  const before = typeof included === "number" ? Math.max(0, used - included) : 0;
  const after = typeof included === "number" ? Math.max(0, used + amount - included) : 0;
  return chargeOfPricing(pricing, before, after);
};

/** The priced lines one usage event records, for the report and the read model. */
export const pricedOf = (
  pricing: Pricing | null | undefined,
  included: number | "unlimited" | null,
  used: number,
  amount: number,
): ReadonlyArray<PricedLine> => {
  if (pricing === null || pricing === undefined) return [];
  const before = typeof included === "number" ? Math.max(0, used - included) : 0;
  const after = typeof included === "number" ? Math.max(0, used + amount - included) : 0;
  return pricedLines(pricing, before, after);
};

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
  readonly kind?: AllowanceKind;
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
 * What one allowance starts a window with when its own boundary fires. The
 * same carry rule as a period close, but for a schedule the period does not
 * own.
 */
export const resetOfFeature = (
  state: SubscribedState,
  feature: string,
  allowance: Allowance,
): { readonly remaining: number | null; readonly carried: number } => {
  const start = includedRemainingOf(allowance);
  if (start === null) return { remaining: null, carried: 0 };
  if (allowance.carryOver !== true) return { remaining: start, carried: 0 };
  const cap = carryCapOf(allowance) ?? start;
  const carried = Math.min(Math.max(remainingOf(state, feature) ?? 0, 0), cap);
  return { remaining: start + carried, carried };
};

/** The quantity an account holds of a non-consumable feature. */
export const quantityOf = (state: SubscribedState, feature: string, allowance: Allowance): number =>
  state.quantities?.[feature] ?? (typeof allowance.included === "number" ? allowance.included : 0);

/** The billable part of a quantity: what is held past the free grant. */
export const billableQuantityOf = (quantity: number, included: number): number =>
  Math.max(0, quantity - included);

/**
 * The quantity a tier change leaves in place: the account keeps what it holds,
 * and a tier that includes more raises it to the new grant. A tier that
 * includes fewer does not take seats away; the next period bills them.
 */
export const quantityAfterTierChange = (held: number, included: number): number =>
  Math.max(held, included);

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
  if (isQuantityGrant(allowance) || allowance.resets === "never" || !periodTiedReset(allowance)) {
    return { remaining: remainingOf(state, feature), carried: 0, kept: true };
  }
  if (allowance.carryOver !== true) return { remaining: start, carried: 0, kept: false };
  const cap = carryCapOf(allowance);
  const carried = Math.min(Math.max(remainingOf(state, feature) ?? 0, 0), cap ?? start);
  return { remaining: start + carried, carried, kept: false };
};

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
  "TierChangeScheduled",
  "TierChangeWithdrawn",
  "PeriodClosed",
  "UsageReset",
  "CreditsExpired",
  "SubscriptionExpired",
  "ProviderRefAttached",
  "AllowanceReset",
  "QuantityChanged",
  "QuantityProrationInvoiced",
] as const;
