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
import { BillingControls, CustomerDetails, EntityId, EntityStatus } from "../Customer.ts";
import { CreditRateCards } from "../Feature.ts";
import { chargeOfPricing, pricedLines, type PricedLine } from "../Pricing.ts";
import { Proration } from "../Proration.ts";
import { CreditsExpire, Interval, Price, TopUpTerms } from "../Tier.ts";
import { PendingActivations } from "./PendingActivation.ts";
import { PlanCancellations } from "./PlanCancellation.ts";
import {
  DEFAULT_PLAN_GROUP,
  mergeAllowances,
  mergeRates,
  duePhases,
  planInGroup,
  planOrder,
  primaryPlan,
  withoutStalePhases,
  type PlanPhase,
  type PlanRow,
  PlanSchedule,
  Plans,
} from "./PlanSet.ts";

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
  /**
   * How much of this refund a provider has since reversed. Absent on a record
   * absent when none came back.
   */
  reversed: Schema.optionalKey(Schema.Int),
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
 * The quantity of every non-consumable feature the account bought, including
 * the free grant. A seat is set, not spent, so this is not a counter a period
 * close resets; `occupied` is the second half of the pair.
 */
export const QuantityCounts = Schema.Record(Schema.String, Schema.Int);

export type QuantityCounts = typeof QuantityCounts.Type;

/**
 * The quantity of every non-consumable feature in use. Occupancy is written by
 * `SetUsage`, never by a plan change or a period close, and it may exceed what
 * was purchased: `remaining` is then negative and new occupancy is blocked
 * while the people already using a seat keep working (ADR 0036).
 */
export const OccupancyCounts = Schema.Record(Schema.String, Schema.Int);

export type OccupancyCounts = typeof OccupancyCounts.Type;

/**
 * One standalone balance grant. A grant belongs to the customer, not to a plan:
 * a lifetime grant has no `expiresAt` and survives every close and plan change
 * (ADR 0037). `granted` is what it started with; `remaining` is what is left
 * after the plan and rollover sources were spent.
 */
export const BalanceGrantRecord = Schema.Struct({
  id: Schema.String,
  feature: Schema.String,
  granted: Schema.Int,
  remaining: Schema.Int,
  /** The deadline an expiring grant ends at. Absent means it never expires. */
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** The plan that was active when it was granted, for a console to attribute it. */
  planId: Schema.optionalKey(Schema.String),
});

export type BalanceGrantRecord = typeof BalanceGrantRecord.Type;

/** Every standalone grant this account holds, keyed by the grant's id. */
export const BalanceGrants = Schema.Record(Schema.String, BalanceGrantRecord);

export type BalanceGrants = typeof BalanceGrants.Type;

/** A quantity change's money, keyed by the command that recorded it. */
export const QuantityProration = Schema.Struct({
  feature: Schema.String,
  proration: Proration,
  /** The provider invoice that collected a positive `due`. */
  invoiceId: Schema.optionalKey(Schema.String),
  /**
   * How much of a credit (`proration.due < 0`) a later charge has consumed.
   * Absent means none; `-due - creditApplied` is what is left to apply
   * (ADR 0042).
   */
  creditApplied: Schema.optionalKey(Schema.Int),
  /**
   * When the change was recorded. Credits are consumed oldest first, so two
   * credits resolve in the order they were logged, not in whatever order a
   * snapshot kept its keys.
   */
  recordedAt: Schema.optionalKey(Schema.DateTimeUtc),
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
  /** The grant units this hold took, keyed by grant id, so a release returns them. */
  grantsUsed: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
});

export type HoldRecord = typeof HoldRecord.Type;

/**
 * The tier the standing moves to when the current period closes, with the terms
 * it carries. `PlanPhase` is the schema; this alias is the name the scheduled
 * change's event and the read model still use.
 */
export { PlanPhase as PendingTier } from "./PlanSet.ts";

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
 * The parts of one scope a balance is read and written through. The customer's
 * scope lives at the top of the standing; an entity's is one record beside it.
 * A scope has its own plan set and its own sources and no second standing: the
 * period, the status, the credit pool and the holds belong to the customer
 * (ADR 0040 §2–3). `allowances` is derived from `plans` through `allowancesOf`,
 * exactly as it is for the customer, so there is one source of truth.
 */
export const ScopeState = Schema.Struct({
  plans: Plans,
  remaining: Remaining,
  usage: Schema.optionalKey(UsageCounts),
  resetAt: Schema.optionalKey(ResetWindows),
  grants: Schema.optionalKey(BalanceGrants),
  quantities: Schema.optionalKey(QuantityCounts),
  occupied: Schema.optionalKey(OccupancyCounts),
});

export type ScopeState = typeof ScopeState.Type;

/**
 * One entity of a customer, as the aggregate holds it: its scope state plus the
 * lifecycle the log records. There is no `detached` record — that is the
 * absence of an entry. An archived record is retained with its history, never
 * deleted, so a bill that names it still resolves (ADR 0003, ADR 0040 §7).
 */
export const EntityRecord = Schema.Struct({
  ...ScopeState.fields,
  id: EntityId,
  name: Schema.optionalKey(Schema.String),
  status: EntityStatus,
  createdAt: Schema.DateTimeUtc,
  archivedAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export type EntityRecord = typeof EntityRecord.Type;

/** Every entity of a customer, keyed by the entity id. */
export const Entities = Schema.Record(Schema.String, EntityRecord);

export type Entities = typeof Entities.Type;

/**
 * What an account with no standing looks like: it may still hold checkout refs,
 * and a one-off pack may already have put credits in its pool.
 */
export const UnsubscribedState = Schema.TaggedStruct("Unsubscribed", {
  refs: Refs,
  /**
   * Every quote a hosted purchase wrote, keyed by the vendor reference of the
   * purchase it was quoted for (ADR 0044 §1). A checkout is opened before a
   * standing exists, so the quotes live on the unsubscribed state too;
   * `AttachProviderRef` merges one and an activation clears them all, because
   * one account has one standing.
   */
  pendingActivations: Schema.optionalKey(PendingActivations),
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
  /**
   * The controls the customer states over its plan. They are written before a
   * plan can exist, so they sit on the unsubscribed state too; a control is
   * validated against the catalog, not the current plan, so it binds when a
   * plan grants the feature. With no plan there is no top-up line (ADR 0026).
   */
  billingControls: Schema.optionalKey(BillingControls),
  /**
   * The identity the customer recorded about itself, before or after it bought
   * anything. It is a latch: no billing decision reads it, and a plan change, a
   * close and a cancellation leave it where it was (ADR 0045).
   */
  customer: Schema.optionalKey(CustomerDetails),
  /**
   * The child scopes under this customer, beside the customer's own scope. An
   * entity is a partition of this one aggregate, so it lives here rather than
   * in a stream of its own (ADR 0040 §2). It exists before a plan can: a scope
   * is created, then a plan is attached to it.
   */
  entities: Schema.optionalKey(Entities),
});

export type UnsubscribedState = typeof UnsubscribedState.Type;

/** What an account that has ever had a tier looks like. */
export const SubscribedState = Schema.TaggedStruct("Subscribed", {
  /**
   * Every active plan, one base plan per group and any add-ons beside them
   * (ADR 0039). The plan set is the account's subscription: a row carries what
   * the plan grants and the terms the boundary needs to move to it.
   */
  plans: Plans,
  /**
   * The phases the account moves through, in the order they start. A phase is
   * future-only and the list is ordered, so the boundary applies them in turn
   * before it resets the counters (ADR 0039 §3).
   */
  schedule: PlanSchedule,
  /**
   * The groups waiting to resolve at their boundary, keyed by group. A
   * cancellation names a group and carries the fallback terms the close needs,
   * so an account may cancel one group without ending the standing (ADR 0039
   * §5).
   */
  cancellations: Schema.optionalKey(PlanCancellations),
  /**
   * The instant of the last scheduled phase this standing applied. A phase that
   * fires at the period boundary grants the new plan's pool and leaves the
   * close to reset the counters onto it; the close reads this to know the plan
   * already landed (ADR 0039 §3).
   */
  lastPhaseAppliedAt: Schema.optionalKey(Schema.DateTimeUtc),
  status: SubscriptionStatus,
  period: Period,
  /** The provider's latest plan charge, kept so a cancellation can refund it. */
  lastChargeId: Schema.optionalKey(Schema.String),
  /**
   * The money the last tier change moved, copied from its event. A positive
   * `due` is what `ChargeProration` bills; a negative one is a credit recorded
   * for audit. Nothing applies that credit automatically: paying it out is a
   * refund, and a later period is a provider charge the deployment owns.
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
   * account nothing has failed for (ADR 0027).
   */
  topUpFailure: Schema.optionalKey(TopUpFailureRecord),
  /**
   * How many refills in a row the provider has refused, since the last one that
   * landed or the last time the line was re-established. It is what a scheduled
   * retry compares itself to, so an old deadline cannot charge a card the
   * budget already spent (ADR 0031).
   */
  topUpAttempts: Schema.Int,
  /**
   * Money this account was charged, per currency: a fold of `PaymentRecorded`,
   * `CreditsPurchased.price`, `ProrationInvoiced` and
   * `QuantityProrationInvoiced`. It is the ceiling a refund is measured
   * against (ADR 0019).
   */
  charged: Schema.optionalKey(MoneyByCurrency),
  /** Money that went back, per currency: a fold of `RefundRecorded`. */
  refunded: Schema.optionalKey(MoneyByCurrency),
  /** Every refund, keyed by the operator command that recorded it. */
  refunds: Schema.optionalKey(Schema.Record(Schema.String, RefundRecord)),
  /**
   * The controls the customer states over its plan: its auto top-up line, its
   * spend ceilings and its usage alerts. A plan change and a close leave them
   * alone, because they belong to the customer and not to the plan (ADR 0038).
   */
  billingControls: Schema.optionalKey(BillingControls),
  /**
   * The identity the customer recorded about itself: its name, its email and
   * when the record was made. A plan change, a close and a cancellation leave
   * it where it was, because it belongs to the customer, not to the plan
   * (ADR 0045).
   */
  customer: Schema.optionalKey(CustomerDetails),
  /**
   * The child scopes under this customer, each with its own plan set and
   * sources (ADR 0040 §2–3). An entity is skipped by a close once archived:
   * its plans ended at the archive and the pool belongs to the customer.
   */
  entities: Schema.optionalKey(Entities),
  /**
   * The thresholds whose alert has already fired this period, keyed by feature.
   * A period close and an activation start the set over; an allowance's own
   * reset window does not (ADR 0038).
   */
  alertsFired: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.Int))),
  usage: UsageCounts,
  /**
   * Money billed this period, per feature, in the standing's currency. A fold
   * of `UsageRecorded.charge`, reset by `UsageReset`; never a second counter.
   */
  billed: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
  remaining: Remaining,
  /**
   * Units drawn from the customer's pooled source for a feature this window,
   * every scope's draws included. `remaining` says how much of the pool is
   * left; this says how much of its included amount is gone, which is what a
   * pool that bills overage is charged against (ADR 0040 §3). Reset with
   * `remaining` on a close or a plan move; absent on state written before it.
   */
  poolSpent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
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
   * The quantity of every non-consumable feature in use, written by
   * `SetUsage`. A plan change and a period close never move it: occupancy is
   * not spent usage.
   */
  occupied: Schema.optionalKey(OccupancyCounts),
  /**
   * Standalone grants, keyed by id. They are a balance source of their own:
   * the plan is spent before a grant, and a lifetime grant survives a close
   * and a plan change (ADR 0037).
   */
  grants: Schema.optionalKey(BalanceGrants),
  /**
   * The unbilled money a quantity change moved, keyed by the command that
   * recorded it. A positive `due` is collected by `ChargeQuantityProration`;
   * a negative one is a credit, spent by `ApplyQuantityCredit` against the
   * next charge in the same currency and never paid out (ADR 0042).
   */
  quantityProrations: Schema.optionalKey(Schema.Record(Schema.String, QuantityProration)),
  refs: Refs,
  /**
   * Every quote a hosted purchase wrote, keyed by the vendor reference of the
   * purchase it was quoted for (ADR 0044 §1). It sits beside `refs` because it
   * belongs to the same purchases; a same-reference write overwrites, a
   * different reference adds, and an activation clears the map.
   */
  pendingActivations: Schema.optionalKey(PendingActivations),
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

/** The base plan of one group, or `undefined` when the group holds none. */
export const planOfGroup = (
  state: SubscribedState,
  group: string = DEFAULT_PLAN_GROUP,
): PlanRow | undefined => planInGroup(state.plans, group);

/**
 * The plan the account is sold under: the default group's plan, else any base
 * plan. `check` and the spend path read it first; an add-on merges after it.
 */
export const primaryPlanOf = (state: SubscribedState): PlanRow | undefined =>
  primaryPlan(state.plans);

/** Every active plan, in the order a merge reads them. */
export const planRowsOf = (state: SubscribedState): ReadonlyArray<PlanRow> =>
  planOrder(state.plans);

/**
 * Every entity of a customer, archived ones included, in id order. The order is
 * the rule and not the insertion order, so a replayed log and a live state list
 * the same scopes the same way.
 */
export const entityRecordsOf = (state: SubscriptionState): ReadonlyArray<EntityRecord> =>
  Object.values(state.entities ?? {}).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

/** One entity's record, or `undefined` when the log never created it. */
export const entityOf = (state: SubscriptionState, entityId: string): EntityRecord | undefined =>
  state.entities?.[entityId];

/**
 * Whether an entity exists and was archived. An unknown id is not archived: it
 * never existed, which is `EntityUnknown` and a different answer.
 */
export const entityArchived = (state: SubscriptionState, entityId: string): boolean =>
  entityOf(state, entityId)?.status === "archived";

/**
 * The state one scope's balance is read and written through. The customer's
 * scope is the standing itself; an entity's is the same standing with that
 * record's plan set and counters overlaid, so every helper that takes a scope
 * (`allowancesOf`, `remainingOf`, `grantsForSpend`, `quantityOf`) is the one
 * function it always was (ADR 0040 §2).
 */
export const scopeStateOf = (state: SubscriptionState, entityId?: string): SubscribedState => {
  const scope =
    entityId === undefined
      ? state._tag === "Subscribed"
        ? state
        : undefined
      : state.entities?.[entityId];

  // An unsubscribed customer's scope has no plan and no source. It still reads
  // as a standing with empty counters so the same helpers answer it, which is
  // what an archive of a scope created before its plan needs.
  if (scope === undefined) {
    return {
      _tag: "Subscribed",
      plans: {},
      schedule: [],
      status: "expired",
      period: { start: DateTime.makeUnsafe(0), end: DateTime.makeUnsafe(0), anchorTz: "UTC" },
      cancelAtPeriodEnd: false,
      credits: 0,
      topUpAttempts: 0,
      usage: {},
      remaining: {},
      holds: {},
      refs: state.refs,
      trialUsed: false,
      dedupeKeys: {},
      dunningAttempts: 0,
    };
  }

  // SAFETY: an entity's scope shares the standing's period, pool and status and
  // overrides only the six scope fields, so the result is a standing whose
  // readers see that record's plan set and counters.
  return {
    ...state,
    plans: scope.plans,
    remaining: scope.remaining,
    usage: scope.usage ?? {},
    resetAt: scope.resetAt ?? {},
    grants: scope.grants ?? {},
    quantities: scope.quantities ?? {},
    occupied: scope.occupied ?? {},
  } as SubscribedState;
};

/**
 * Whether the customer's item for a feature is pooled: one shared source every
 * attached entity draws on (ADR 0040 §3).
 */
export const pooledOf = (state: SubscribedState, feature: string): boolean =>
  allowancesOf(state)[feature]?.pooled === true;

/**
 * The pooled source's remaining for a feature, or `null` when the customer's
 * item is not pooled. One number, owned by the customer: an entity's breakdown
 * shows it as a `pooled: true` row whose `remaining` is this (ADR 0040 §4).
 */
export const pooledRemainingOf = (state: SubscribedState, feature: string): number | null => {
  const allowance = allowancesOf(state)[feature];

  if (allowance?.pooled !== true) return null;
  const remaining = recordedCount(state.remaining, feature);

  return remaining !== undefined ? remaining : includedRemainingOf(allowance);
};

/**
 * The units drawn from the customer's pooled source for a feature this window,
 * or what an older record's `remaining` implies. A feature the customer does
 * not pool is `0`; a record written before the counter existed falls back to
 * the difference between the pool's own grant and what it has left, which is
 * the same number whenever no carry is in the window.
 */
export const poolSpentOf = (state: SubscribedState, feature: string): number => {
  const recorded = state.poolSpent?.[feature];

  if (recorded !== undefined) return recorded;
  const allowance = allowancesOf(state)[feature];
  const remaining = pooledRemainingOf(state, feature);

  return allowance?.pooled === true && typeof allowance.included === "number" && remaining !== null
    ? Math.max(0, allowance.included - remaining)
    : 0;
};

/** Every feature a scope holds a count for, pooled items included. */
export const scopeFeaturesOf = (state: SubscribedState, entityId?: string): ReadonlyArray<string> =>
  Object.keys(allowancesOf(scopeStateOf(state, entityId)));

/** Every add-on attached to the account. */
export const addOnsOf = (state: SubscribedState): ReadonlyArray<PlanRow> =>
  planOrder(state.plans).filter((row) => row.addOn);

/**
 * The id of the plan the account is sold under, or `""` when the plan set is
 * empty. A standing always has one plan in this slice; the empty case is what a
 * cancellation leaves behind, and `standingTierOf` is the null-returning read.
 */
export const planIdOf = (state: SubscribedState): string => primaryPlanOf(state)?.planId ?? "";

/**
 * The allowances a spend path reads: every active plan's items, merged by
 * feature. One plan merges to itself; an add-on adds its included amount to the
 * feature it grants (ADR 0039 §2).
 */
export const allowancesOf = (state: SubscribedState): Allowances => mergeAllowances(state.plans);

/** Every credit-priced feature's rate card, add-ons included. */
export const ratesOf = (state: SubscribedState): CreditRateCards => mergeRates(state.plans);

/** The currency the account is sold in, from the plan it is sold under. */
export const currencyOf = (state: SubscribedState): string | undefined =>
  primaryPlanOf(state)?.currency;

/** The cadence of the account's period, from the plan it is sold under. */
export const intervalOf = (state: SubscribedState): Interval =>
  primaryPlanOf(state)?.interval ?? "month";

/** What the account pays, from the plan it is sold under. */
export const priceOf = (state: SubscribedState): Price | undefined => primaryPlanOf(state)?.price;

/** Whether the sold plan's own pool expires at a close. */
export const creditsExpireOf = (state: SubscribedState): CreditsExpire =>
  primaryPlanOf(state)?.creditsExpire ?? "period";

/** The sold plan's auto top-up line, before the customer's controls apply. */
export const topUpTermsOf = (state: SubscribedState): TopUpTerms | undefined =>
  primaryPlanOf(state)?.topUp;

/** The schedule the account will move through, in start order. */
export const scheduleOf = (state: SubscribedState): PlanSchedule => state.schedule ?? [];

/** The phases due at or before an instant, in start order, that the held generation has not outrun. */
export const duePhasesOf = (state: SubscribedState, at: DateTime.Utc): ReadonlyArray<PlanPhase> =>
  duePhases(withoutStalePhases(state.plans, state.schedule), at.epochMilliseconds);

/** The next phase of one group, or `undefined` when the group has none. */
export const pendingPlanOf = (
  state: SubscribedState,
  group: string = DEFAULT_PLAN_GROUP,
): PlanPhase | undefined =>
  state.schedule
    .filter((phase) => phase.group === group)
    .sort((a, b) => a.at.epochMilliseconds - b.at.epochMilliseconds)[0];

/** Sum of a feature's usage. */
export const usedOf = (state: SubscribedState, feature: string): number =>
  state.usage[feature] ?? 0;

/** Money already billed for one feature this period, or `0`. */
export const billedOf = (state: SubscribedState, feature: string): number =>
  state.billed?.[feature] ?? 0;

/**
 * The auto top-up line in force for this customer, or `null` when it never
 * refills. The customer's own line wins over the tier's; `enabled: false` turns
 * the tier's line off without a deploy. `pack`, `cooldown` and `retry` stay the
 * tier's, because they are catalog facts and not a customer's to state.
 */
export const effectiveTopUpOf = (
  terms: TopUpTerms | undefined,
  billingControls: BillingControls | undefined,
): TopUpTerms | null => {
  const control = billingControls?.autoTopUp;

  if (control?.enabled === false) return null;

  const threshold = control?.threshold ?? terms?.threshold;

  if (threshold === undefined) return null;

  return terms === undefined ? { threshold } : { ...terms, threshold };
};

/** The auto top-up line in force for this customer, or `null` when it never refills. */
export const topUpOf = (state: SubscriptionState): TopUpTerms | null =>
  state._tag === "Subscribed" ? effectiveTopUpOf(topUpTermsOf(state), state.billingControls) : null;

/** The credits at or below which a spend on this standing is a crossing, or `null`. */
export const topUpThresholdOf = (state: SubscriptionState): number | null =>
  topUpOf(state)?.threshold ?? null;

/**
 * The customer's money ceiling for one feature this period, or `null` when it
 * states none. It is enforced in addition to the tier's own ceilings.
 */
export const spendLimitOf = (state: SubscriptionState, feature: string): number | null =>
  state.billingControls?.spendLimits?.find((limit) => limit.featureId === feature)?.amount ?? null;

/**
 * The alert thresholds configured for one feature, in ascending order so the
 * events of one crossing are deterministic.
 */
export const alertThresholdsOf = (
  state: SubscriptionState,
  feature: string,
): ReadonlyArray<number> =>
  (state.billingControls?.usageAlerts ?? [])
    .filter((alert) => alert.featureId === feature)
    .map((alert) => alert.at)
    .sort((left, right) => left - right);

/** The thresholds one feature's alerts have already fired this period. */
export const alertsFiredOf = (state: SubscriptionState, feature: string): ReadonlyArray<number> =>
  state._tag === "Subscribed" ? (state.alertsFired?.[feature] ?? []) : [];

/** The tier this standing is on, or `null` when it never subscribed. */
export const standingTierOf = (state: SubscriptionState): string | null =>
  state._tag === "Subscribed" ? planIdOf(state) || null : null;

/**
 * The last refill this standing could not buy, or `null` when nothing failed or
 * a purchase has since succeeded. A failure is a standing's fact, so an account
 * with no plan has none.
 */
export const topUpFailureOf = (state: SubscriptionState): TopUpFailureRecord | null =>
  state._tag === "Subscribed" ? (state.topUpFailure ?? null) : null;

/** How many refills in a row a provider has refused. Absent state is none. */
export const topUpAttemptsOf = (state: SubscriptionState): number =>
  state._tag === "Subscribed" ? state.topUpAttempts : 0;

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

/**
 * The refund one provider id recorded, with the command that wrote it. The log
 * keys refunds by the operator action (ADR 0019); a reversal arrives naming the
 * provider's id, so it has to be found the other way round (ADR 0030).
 */
export const refundOfProviderId = (
  state: SubscriptionState,
  refundId: string,
): { readonly commandId: string; readonly record: RefundRecord } | null => {
  for (const [commandId, record] of Object.entries(state.refunds ?? {})) {
    if (record.refundId === refundId) return { commandId, record };
  }

  return null;
};

/**
 * Add what came back to one refund's record, found by its provider id. A refund
 * the log does not hold is left alone rather than invented: `ReverseRefund`
 * refuses that case before it reaches here.
 */
export const reversedWith = (
  refunds: Readonly<Record<string, RefundRecord>> | undefined,
  refundId: string,
  amount: number,
) => {
  const found = Object.entries(refunds ?? {}).find(([, record]) => record.refundId === refundId);

  if (found === undefined) return refunds ?? {};

  const [commandId, record] = found;

  return { ...refunds, [commandId]: { ...record, reversed: (record.reversed ?? 0) + amount } };
};

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
 * How much of a quantity credit a later charge may still consume. A positive or
 * zero `due` is a charge, not a credit, so it has nothing to apply.
 */
export const unappliedQuantityCreditOf = (entry: QuantityProration): number =>
  entry.proration.due < 0 ? Math.max(0, -entry.proration.due - (entry.creditApplied ?? 0)) : 0;

/** One credit a quantity charge in a currency may consume. */
export interface QuantityCreditAvailable {
  readonly prorationId: string;
  readonly available: number;
  readonly recordedAt: DateTime.Utc | undefined;
}

/** One credit a charge consumes, and how much of it. */
export interface QuantityCreditAllocation {
  readonly prorationId: string;
  readonly amount: number;
}

/**
 * The credits a quantity charge in `currency` may consume, oldest first. A
 * credit belongs to the customer's money, not to the scope that changed the
 * quantity, so a change under one entity can spend a credit another scope
 * recorded (ADR 0040 §3). A currency only spends its own credits.
 */
export const quantityCreditsOf = (
  state: SubscriptionState,
  currency: string,
  exceptProrationId?: string,
): ReadonlyArray<QuantityCreditAvailable> => {
  const entries = state._tag === "Subscribed" ? (state.quantityProrations ?? {}) : {};

  return Object.entries(entries)
    .filter(
      ([prorationId, entry]) =>
        prorationId !== exceptProrationId &&
        entry.proration.currency === currency &&
        unappliedQuantityCreditOf(entry) > 0,
    )
    .map(([prorationId, entry]) => ({
      prorationId,
      available: unappliedQuantityCreditOf(entry),
      recordedAt: entry.recordedAt,
    }))
    .sort((left, right) => {
      const leftAt = left.recordedAt === undefined ? 0 : DateTime.toEpochMillis(left.recordedAt);
      const rightAt = right.recordedAt === undefined ? 0 : DateTime.toEpochMillis(right.recordedAt);

      if (leftAt !== rightAt) return leftAt - rightAt;

      return left.prorationId < right.prorationId
        ? -1
        : left.prorationId > right.prorationId
          ? 1
          : 0;
    });
};

/**
 * The credits a charge consumes, capped by its `due`. A credit larger than the
 * charge leaves the remainder on its own entry for a later charge; the charge
 * never goes below zero, so no credit is paid out as cash (ADR 0042).
 */
export const quantityCreditUsesOf = (
  due: number,
  credits: ReadonlyArray<QuantityCreditAvailable>,
): ReadonlyArray<QuantityCreditAllocation> => {
  let remaining = Math.max(0, due);
  const uses: Array<QuantityCreditAllocation> = [];

  for (const credit of credits) {
    if (remaining === 0) break;
    const amount = Math.min(remaining, credit.available);

    if (amount > 0) {
      uses.push({ prorationId: credit.prorationId, amount });
      remaining -= amount;
    }
  }

  return uses;
};

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
  const allowance = allowancesOf(state)[feature];

  return allowance === undefined ? 0 : includedRemainingOf(allowance);
};

/** The count an allowance window starts with, and how much of it carried. */
export interface AllowanceWindowReset {
  readonly remaining: number | null;
  readonly carried: number;
}

/**
 * What one allowance starts a window with when its own boundary fires. The
 * same carry rule as a period close, but for a schedule the period does not
 * own.
 */
export const resetOfFeature = (
  state: SubscribedState,
  feature: string,
  allowance: Allowance,
): AllowanceWindowReset => {
  const start = includedRemainingOf(allowance);

  if (start === null) return { remaining: null, carried: 0 };

  if (allowance.carryOver !== true) return { remaining: start, carried: 0 };
  const cap = carryCapOf(allowance) ?? start;
  const carried = Math.min(Math.max(remainingOf(state, feature) ?? 0, 0), cap);

  return { remaining: start + carried, carried };
};

/** The quantity an account bought of a non-consumable feature. */
export const quantityOf = (state: SubscribedState, feature: string, allowance: Allowance): number =>
  state.quantities?.[feature] ?? (typeof allowance.included === "number" ? allowance.included : 0);

/** The quantity in use of a non-consumable feature. */
export const occupiedOf = (state: SubscribedState, feature: string): number =>
  state.occupied?.[feature] ?? 0;

/**
 * What a non-consumable feature has left to occupy: purchased minus occupied.
 * It may be negative, because a purchase change never removes an occupied seat.
 */
export const seatBalanceOf = (state: SubscribedState, feature: string, allowance: Allowance) =>
  quantityOf(state, feature, allowance) - occupiedOf(state, feature);

/** Every standalone grant this account holds for one feature, expiry first. */
export const grantsOf = (
  state: SubscribedState,
  feature: string,
): ReadonlyArray<BalanceGrantRecord> =>
  Object.values(state.grants ?? {})
    .filter((grant) => grant.feature === feature)
    .toSorted((left, right) => {
      const leftAt =
        left.expiresAt === undefined ? Number.MAX_SAFE_INTEGER : left.expiresAt.epochMilliseconds;

      const rightAt =
        right.expiresAt === undefined ? Number.MAX_SAFE_INTEGER : right.expiresAt.epochMilliseconds;

      return leftAt - rightAt || left.id.localeCompare(right.id);
    });

/** How much of a feature's balance is a standalone grant. */
export const grantTotalOf = (state: SubscribedState, feature: string): number =>
  grantsOf(state, feature).reduce((sum, grant) => sum + grant.remaining, 0);

/**
 * The plan-and-rollover part of a safeguard: the total spendable count less
 * the grants. It is what a spend must exhaust before it takes a grant unit, so
 * a lifetime grant is the last money a customer can spend.
 */
export const planPartOf = (state: SubscribedState, feature: string): number =>
  Math.max(0, (remainingOf(state, feature) ?? 0) - grantTotalOf(state, feature));

/** The grant units a spend of `amount` takes, in deduction order. */
export const grantsForSpend = (state: SubscribedState, feature: string, amount: number) => {
  let left = Math.max(0, amount - planPartOf(state, feature));
  const used: Record<string, number> = {};

  for (const grant of grantsOf(state, feature)) {
    if (left <= 0) break;

    const take = Math.min(left, grant.remaining);

    if (take > 0) {
      used[grant.id] = take;
      left -= take;
    }
  }

  return used;
};

/** Deduct a grant allocation from the map, leaving every other grant alone. */
export const grantsAfterSpend = (
  grants: BalanceGrants | undefined,
  used: Readonly<Record<string, number>>,
): BalanceGrants => {
  const next = { ...grants };

  for (const [id, amount] of Object.entries(used)) {
    const grant = next[id];

    if (grant === undefined) continue;
    next[id] = { ...grant, remaining: Math.max(0, grant.remaining - amount) };
  }

  return next;
};

/**
 * Return a hold's grant allocation. A hold that took an expiring grant before
 * a lifetime one gives the lifetime units back first, so the source that would
 * expire soonest is the one left spent.
 */
export const grantsAfterReturn = (
  grants: BalanceGrants | undefined,
  allocation: Readonly<Record<string, number>> | undefined,
  returned: number,
): BalanceGrants => {
  const next = { ...grants };

  if (allocation === undefined || returned <= 0) return next;

  let left = returned;
  const entries = Object.entries(allocation).toReversed();

  for (const [id, allocated] of entries) {
    if (left <= 0) break;

    const amount = Math.min(left, allocated);
    const grant = next[id];

    if (grant === undefined) continue;
    next[id] = {
      ...grant,
      remaining: Math.min(grant.granted, grant.remaining + amount),
    };
    left -= amount;
  }

  return next;
};

/** The grant units a release of `returned` should give back, against an allocation. */
export const grantsReturnedFor = (
  allocation: Readonly<Record<string, number>> | undefined,
  returned: number,
) => {
  const result: Record<string, number> = {};
  let left = returned;

  for (const [id, allocated] of Object.entries(allocation ?? {}).toReversed()) {
    if (left <= 0) break;

    const take = Math.min(left, allocated);

    if (take > 0) {
      result[id] = take;
      left -= take;
    }
  }

  return result;
};

/** Add one grant, keeping the map empty when there is nothing to add. */
export const grantedWith = (
  grants: BalanceGrants | undefined,
  grant: BalanceGrantRecord,
): BalanceGrants => ({ ...grants, [grant.id]: grant });

/** Remove one grant, leaving every other grant alone. */
export const grantsWithout = (
  grants: BalanceGrants | undefined,
  grantId: string,
): BalanceGrants => {
  const { [grantId]: _expired, ...rest } = grants ?? {};

  return rest;
};

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
export interface AllowancePeriodReset extends AllowanceWindowReset {
  readonly kept: boolean;
}

export const resetOf = (
  state: SubscribedState,
  feature: string,
  allowance: Allowance,
): AllowancePeriodReset => {
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
  creditsExpireOf(state) === "never" ? 0 : state.credits - prepaidCreditsOf(state);

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
  ratesOf(state)[feature] === undefined
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
  "PlanChanged",
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
  "PlanChangeScheduled",
  "TierChangeWithdrawn",
  "PeriodClosed",
  "UsageReset",
  "CreditsExpired",
  "SubscriptionCanceled",
  "SubscriptionExpired",
  "ProviderRefAttached",
  "PlanItemReset",
  "QuantityChanged",
  "UsageSet",
  "BalanceGranted",
  "BalanceExpired",
  "QuantityProrationInvoiced",
  "QuantityCreditApplied",
] as const;
