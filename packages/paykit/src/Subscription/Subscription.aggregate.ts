import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  isFlagGrant,
  isQuantityGrant,
  pricingOf,
  type AllowanceKind,
  type Included,
  type Overage,
  type Resets,
} from "../Allowance.ts";
import { Actor, mayActOn } from "../Auth/Actor.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { controlsKey, normalizeBillingControls, type BillingControls } from "../Customer.ts";
import { soleUnitPriceOf } from "../Pricing.ts";
import { prorate, prorateQuantity, sameProration } from "../Proration.ts";
import {
  capacityOf,
  downgradeOf,
  moneyOverflowOf,
  type Capacity,
  type JudgedFeature,
} from "./Allowance.verdict.ts";
import { AlreadyCanceled } from "./AlreadyCanceled.rejection.ts";
import { AlreadySubscribed } from "./AlreadySubscribed.rejection.ts";
import { AttachProviderRef, ProviderRefAttached } from "./AttachProviderRef.command.ts";
import { CancelImmediately, SubscriptionCanceled } from "./CancelImmediately.command.ts";
import {
  ChangeTier,
  DowngradeBelowCeiling,
  DowngradeBelowSpend,
  DowngradeBelowUsage,
  PlanChanged,
} from "./ChangeTier.command.ts";
import {
  ClosePeriod,
  CreditsExpired,
  PeriodClosed,
  PeriodNotClosed,
  UsageReset,
  canClosePeriod,
} from "./ClosePeriod.command.ts";
import { ConsumeCredits, CreditExceedsBalance, CreditsConsumed } from "./ConsumeCredits.command.ts";
import { CurrencyMismatch } from "./CurrencyMismatch.rejection.ts";
import { DunningRetry, DunningRetryDue } from "./DunningRetry.command.ts";
import { AlreadyInGrace, EnterGrace, GraceEntered } from "./EnterGrace.command.ts";
import { Expire, SubscriptionExpired } from "./Expire.command.ts";
import { BalanceExpired, ExpireGrant } from "./ExpireGrant.command.ts";
import { ExtendTrial, TrialExtended, TrialNotActive } from "./ExtendTrial.command.ts";
import { FeatureNotConsumable } from "./FeatureNotConsumable.rejection.ts";
import { GraceElapsed } from "./GraceElapsed.command.ts";
import {
  BalanceGranted,
  FeatureNotCounted,
  FeaturePricedInCredits,
  GrantBalance,
  GrantExpiryNotLater,
} from "./GrantBalance.command.ts";
import { CreditsGranted, GrantCredits } from "./GrantCredits.command.ts";
import {
  Hold,
  HoldExceeded,
  HoldExpired,
  HoldSettled,
  HoldUnknown,
  UsageReserved,
  defaultHoldExpiry,
} from "./Hold.command.ts";
import { HoldElapsed } from "./HoldElapsed.command.ts";
import { nextHoldStatus } from "./HoldPhase.ts";
import { NotInGrace } from "./NotInGrace.rejection.ts";
import { NotScheduled } from "./NotScheduled.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { PeriodEnded } from "./PeriodEnded.command.ts";
import { PlanNotInCatalog } from "./PlanNotInCatalog.rejection.ts";
import { ProrationMismatch } from "./ProrationMismatch.rejection.ts";
import { CreditsPurchased, PurchaseCredits } from "./PurchaseCredits.command.ts";
import {
  NoQuantityProrationDue,
  QuantityProrationInvoiced,
  RecordQuantityProrationInvoice,
} from "./QuantityProration.command.ts";
import { PaymentRecorded, RecordPayment } from "./RecordPayment.command.ts";
import { PaymentFailed, RecordPaymentFailure } from "./RecordPaymentFailure.command.ts";
import {
  NoProrationDue,
  ProrationInvoiced,
  RecordProrationInvoice,
} from "./RecordProrationInvoice.command.ts";
import { RecordTopUpFailure, TopUpFailed } from "./RecordTopUpFailure.command.ts";
import { Recover, Recovered } from "./Recover.command.ts";
import { Refund, RefundExceedsCharged, RefundRecorded } from "./Refund.command.ts";
import { ReleaseHold, UsageReleased } from "./ReleaseHold.command.ts";
import { PlanItemReset, ResetAllowance } from "./ResetAllowance.command.ts";
import { Resume, CancellationWithdrawn } from "./Resume.command.ts";
import { RetryTopUp, TopUpRetryDue } from "./RetryTopUp.command.ts";
import {
  RefundNotFound,
  RefundReversed,
  RefundReversalExceedsRefunded,
  ReverseRefund,
} from "./ReverseRefund.command.ts";
import { CancellationScheduled, ScheduleCancellation } from "./ScheduleCancellation.command.ts";
import { ScheduleTierChange, PlanChangeScheduled } from "./ScheduleTierChange.command.ts";
import {
  BillingControlsSet,
  ControlsDuplicate,
  ControlsFeatureNotPriced,
  ControlsFeatureUnknown,
  SetBillingControls,
  type ControlFeature,
} from "./SetBillingControls.command.ts";
import {
  QuantityCapExceeded,
  QuantityChanged,
  QuantityExceeded,
  QuantityInvalid,
  SetQuantity,
} from "./SetQuantity.command.ts";
import { SettleHold, UsageSettled } from "./SettleHold.command.ts";
import { UsageInvalid } from "./SetUsage.command.ts";
import { SetUsage, UsageSet } from "./SetUsage.command.ts";
import { SpendLimitExceeded } from "./SpendLimitExceeded.rejection.ts";
import {
  activationOf,
  carriedPrepaidOf,
  resetWindowsOf,
  startingRemaining,
  standingFrom,
  unitPriceCurrencyOf,
} from "./Standing.ts";
import { StandingEnded } from "./StandingEnded.rejection.ts";
import { StartTrial, TrialStarted } from "./StartTrial.command.ts";
import { Subscribe, SubscriptionActivated } from "./Subscribe.command.ts";
import { AccountId } from "./Subscription.id.ts";
import {
  addInterval,
  alertThresholdsOf,
  alertsFiredOf,
  allowsUsage,
  chargedWith,
  availableOf,
  billedOf,
  billableUnitsOf,
  canEnterGrace,
  chargeOf,
  creditRateOf,
  creditsOf,
  expiringCreditsOf,
  grantedWith,
  grantTotalOf,
  grantsAfterReturn,
  grantsAfterSpend,
  grantsForSpend,
  grantsOf,
  grantsReturnedFor,
  grantsWithout,
  holdOf,
  includedRemainingOf,
  initialSubscriptionState,
  quantityAfterTierChange,
  quantityOf,
  occupiedOf,
  isTerminalStatus,
  periodFrom,
  prepaidCreditsOf,
  pricedOf,
  protectedAfterSpending,
  remainingAfterRelease,
  remainingAfterSpending,
  nextResetAt,
  remainingOf,
  openHoldsOf,
  refundedOf,
  refundedWith,
  refundOfProviderId,
  reversedWith,
  refundableOf,
  closingHold,
  reservedCreditsOf,
  reservedOf,
  resetOf,
  resetOfFeature,
  standingOf,
  spendLimitOf,
  topUpAttemptsOf,
  topUpOf,
  statusOf,
  SubscriptionState,
  usedOf,
  type HoldRecord,
  type SubscribedState,
  type PendingTier,
  type SubscriptionStatus,
} from "./Subscription.state.ts";
import { TopUpCooldownCleared, TopUpCooldownElapsed } from "./TopUpCooldownElapsed.command.ts";
import {
  AllowanceExceeded,
  CreditExceeded,
  FeatureNotMetered,
  MoneyCapExceeded,
  SpendCapExceeded,
  StandingBlocksUsage,
  TrackUsage,
  UsageRecorded,
} from "./TrackUsage.command.ts";
import { TrialAlreadyUsed } from "./TrialAlreadyUsed.rejection.ts";
import { TrialDeadlineNotLater } from "./TrialDeadlineNotLater.rejection.ts";
import { UsageAlertFired } from "./UsageAlertFired.event.ts";
import {
  NoTierChangeScheduled,
  TierChangeWithdrawn,
  WithdrawTierChange,
} from "./WithdrawTierChange.command.ts";

/** The part of an allowance `decide` reads when it derives a count. */
type CountableAllowance = {
  readonly kind?: AllowanceKind;
  readonly included: Included;
  readonly overage: Overage;
  readonly resets: Resets;
  readonly cap?: number;
};

const remainingAfterChange = (
  state: SubscribedState,
  allowances: Readonly<Record<string, CountableAllowance>>,
): Record<string, number | null> =>
  Object.fromEntries(
    Object.entries(allowances).map(([feature, allowance]) => {
      if (isQuantityGrant(allowance)) {
        const included = typeof allowance.included === "number" ? allowance.included : 0;
        const quantity = quantityAfterTierChange(state.quantities?.[feature] ?? included, included);

        return [feature, quantity - occupiedOf(state, feature)];
      }

      // Usage and open reservations both still owe the old period's units. An
      // allowance with no count — unlimited, or a flag's grant — has none to
      // owe them against.
      const spendable = includedRemainingOf(allowance);

      return [
        feature,
        spendable === null
          ? null
          : spendable -
            usedOf(state, feature) -
            reservedOf(state, feature) +
            // A grant survives a plan change. The total the event records is
            // the new plan's count plus every standalone grant the customer
            // still holds (ADR 0037).
            grantTotalOf(state, feature),
      ];
    }),
  );

const emptyAllowances = (allowances: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(allowances).length === 0;

const subscribed = (state: SubscriptionState, account: string): SubscribedState | NotSubscribed =>
  state._tag === "Subscribed" ? state : new NotSubscribed({ account });

/**
 * The event that returns an open hold's units (or credits) to a standing. A
 * release and a sweep record the same event, because an expired hold is a
 * cleanup and not a charge; `reason` is what tells the two apart in the log.
 */
const releaseEvent = (
  state: SubscribedState,
  hold: HoldRecord,
  reason: "released" | "expired" | "reset",
): UsageReleased => {
  // A credit-priced hold returns what it took — `cost` credits, not `amount`
  // units — so the log's remaining stays in one unit of account.
  const returns = state.rates[hold.feature] === undefined ? hold.amount : hold.cost;

  return new UsageReleased({
    holdId: hold.id,
    feature: hold.feature,
    amount: hold.amount,
    cost: hold.cost,
    remainingAfter: remainingAfterRelease(availableOf(state, hold.feature), returns),
    reason,
    ...(hold.grantsUsed === undefined ? {} : { grantsReturned: hold.grantsUsed }),
  });
};

const closePeriodEvents = (state: SubscribedState, periodEnd: DateTime.Utc) => {
  // A scheduled change lands first: `UsageReset` reads the allowances in state,
  // so the new tier has to be in the log before the counters reset onto it.
  const pending: PendingTier | undefined = state.pendingTier;
  // The boundary is a new period, so it grants the pool the way an activation
  // does: the new tier's credits plus whatever one-off pack the account still
  // holds. Replacing the pool with the grant alone would spend a pack the
  // customer paid for, and dropping `prepaidCredits` would stop protecting it.
  const prepaid = prepaidCreditsOf(state);
  const credits = pending === undefined ? state.credits : pending.credits + prepaid;
  const creditsExpire = pending?.creditsExpire ?? state.creditsExpire;
  const nextPeriodStart = periodEnd;

  // A scheduled change keeps the quantity a non-consumable feature holds, so
  // its new remaining is the new cap less that quantity — not the new grant.
  const pendingRemaining =
    pending === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(
            startingRemaining(pending.allowances, state.quantities, state.occupied),
          ).map(([feature, remaining]) => [
            feature,
            remaining === null ? null : remaining + grantTotalOf(state, feature),
          ]),
        );

  const moved =
    pending === undefined
      ? []
      : [
          new PlanChanged({
            tier: pending.tier,
            allowances: pending.allowances,
            remaining: pendingRemaining!,
            credits,
            ...(prepaid === 0 ? {} : { prepaidCredits: prepaid }),
            creditsExpire,
            ...(pending.topUp === undefined ? {} : { topUp: pending.topUp }),
            rates: pending.rates,
            ...(pending.currency === undefined ? {} : { currency: pending.currency }),
            ...(pending.interval === undefined ? {} : { interval: pending.interval }),
            ...(pending.price === undefined ? {} : { priceAfter: pending.price }),
            ...(() => {
              const resetAt = resetWindowsOf(pending.allowances, nextPeriodStart);

              return Object.keys(resetAt).length === 0 ? {} : { resetAt };
            })(),
          }),
        ];

  const allowances = pending?.allowances ?? state.allowances;
  const nextPeriodEnd = addInterval(nextPeriodStart, state.interval);

  const statusAfter: SubscriptionStatus = state.cancelAtPeriodEnd
    ? "canceled"
    : state.status === "trialing"
      ? "active"
      : state.status;

  // One reset per allowance, so `remaining` and `carried` cannot disagree about
  // what the closing period left behind.
  const resets = [
    ...Object.entries(allowances).map(([feature, allowance]) => {
      const reset =
        pending === undefined
          ? resetOf(state, feature, allowance)
          : {
              remaining: pendingRemaining![feature] ?? null,
              carried: 0,
              kept: isQuantityGrant(allowance),
            };

      return [
        feature,
        {
          ...reset,
          // A grant is not reset by the plan's boundary. A scheduled change's
          // `pendingRemaining` already carries the surviving grants; a close
          // without one adds them here.
          remaining:
            reset.remaining === null
              ? null
              : pending === undefined
                ? reset.remaining + grantTotalOf(state, feature)
                : reset.remaining,
        },
      ] as const;
    }),
    // A grant-only feature is not in the plan's allowances, but its usage still
    // restarts with the period. The grant source itself is untouched.
    ...(() => {
      const seen = new Set<string>();

      return Object.values(state.grants ?? {}).flatMap((grant) => {
        const feature = grant.feature;

        if (seen.has(feature) || allowances[feature] !== undefined) return [];
        seen.add(feature);

        return [
          [feature, { remaining: grantTotalOf(state, feature), carried: 0, kept: false }] as const,
        ];
      });
    })(),
  ];

  // A `resets: "never"` feature keeps its usage, holds and remainder, so the
  // reset does not touch it.
  const kept = Object.fromEntries(
    resets.flatMap(([feature, reset]) => (reset.kept ? [[feature, true]] : [])),
  );

  // Expiry is a property of the grant that is ending. With no scheduled change,
  // that is the plan's own credits for the period just closed: a one-off pack
  // bought from a period pool is never expired, and a `"never"` pool has
  // nothing to return. With a scheduled change the old grant is replaced by the
  // new tier's grant at the boundary, so this close expires nothing of its own:
  // the new grant's `creditsExpire` rule applies at the *next* close.
  const expiring = pending === undefined ? expiringCreditsOf(state) : 0;
  // A boundary clears the holds of every feature that does not keep its
  // counters. Record the return per hold, so the timeline says what left the
  // allowance instead of only `UsageReset` dropping the entities.
  const resetRunning = new Map<string, number | null>();
  const resetReleases: Array<UsageReleased> = [];

  for (const hold of Object.values(state.holds)) {
    if (hold.status !== "open" || kept[hold.feature] === true) continue;
    const returns = state.rates[hold.feature] === undefined ? hold.amount : hold.cost;

    const current = resetRunning.has(hold.feature)
      ? resetRunning.get(hold.feature)!
      : availableOf(state, hold.feature);

    const remainingAfter = remainingAfterRelease(current, returns);
    resetRunning.set(hold.feature, remainingAfter);
    resetReleases.push(
      new UsageReleased({
        holdId: hold.id,
        feature: hold.feature,
        amount: hold.amount,
        cost: hold.cost,
        remainingAfter,
        reason: "reset",
        ...(hold.grantsUsed === undefined ? {} : { grantsReturned: hold.grantsUsed }),
      }),
    );
  }

  return [
    ...moved,
    ...resetReleases,
    new PeriodClosed({
      periodStart: state.period.start,
      periodEnd: state.period.end,
      nextPeriodStart,
      nextPeriodEnd,
      statusAfter,
      standingAfter: standingOf(statusAfter),
      cancelAtPeriodEndAfter: state.cancelAtPeriodEnd,
    }),
    new UsageReset({
      remaining: Object.fromEntries(resets.map(([feature, reset]) => [feature, reset.remaining])),
      carried: Object.fromEntries(resets.map(([feature, reset]) => [feature, reset.carried])),
      ...(Object.keys(kept).length === 0 ? {} : { kept }),
    }),
    // Expiry is a property of the grant: a "never" pool survives the boundary,
    // a one-off pack bought from a period pool is never expired, and a scheduled
    // change's new grant is for the period that starts here.
    ...(pending === undefined && state.creditsExpire === "period"
      ? [
          new CreditsExpired({
            amount: expiring,
            balanceAfter: state.credits - expiring,
          }),
        ]
      : []),
  ];
};

/** The per-feature facts a judgement reads, from the standing itself. */
const judgedOf = (state: SubscribedState, feature: string): JudgedFeature => {
  const allowance = state.allowances[feature];
  const rates = state.rates[feature];
  const included = allowance?.included ?? null;
  const remaining = availableOf(state, feature);
  const used = usedOf(state, feature);
  // A credit-priced feature shares one pool: its `reserved` is the credits
  // every open hold kept out, not the units held on this feature.
  const reserved = rates === undefined ? reservedOf(state, feature) : reservedCreditsOf(state);

  // The write path knows `included`, a read model knows `carried`; the ceiling
  // is written from `remaining`, so the rollover part is derived here.
  const carried =
    typeof included === "number" && remaining !== null
      ? Math.max(0, remaining + used + reserved - included)
      : 0;

  return {
    overage: allowance?.overage ?? "block",
    included,
    ...(allowance?.cap === undefined ? {} : { cap: allowance.cap }),
    carried,
    ...(allowance?.moneyCap === undefined ? {} : { moneyCap: allowance.moneyCap }),
    ...(pricingOf(allowance ?? {}) === null ? {} : { pricing: pricingOf(allowance ?? {})! }),
    ...(spendLimitOf(state, feature) === null ? {} : { spendLimit: spendLimitOf(state, feature)! }),
    billed: billedOf(state, feature),
    used,
    reserved,
    remaining,
    ...(rates === undefined ? {} : { creditRates: rates }),
  };
};

/**
 * The money evidence a `MoneyCapExceeded` carries. The verdict judged the total;
 * this is the split the rejection states — what the event bills, and what the
 * open holds promise — so a caller reads the same numbers `Hold` and `Track`
 * always reported.
 */
const moneyCapRefusalOf = (
  verdict: Extract<Capacity, { readonly _tag: "Money" }>,
  state: SubscribedState,
  feature: string,
  amount: number,
): MoneyCapExceeded => {
  const allowance = state.allowances[feature];
  const used = usedOf(state, feature);
  const reserved = reservedOf(state, feature);

  const reservedCharge = chargeOf(
    pricingOf(allowance ?? {}),
    allowance?.included ?? null,
    used,
    reserved,
  );

  return new MoneyCapExceeded({
    feature,
    cap: verdict.cap,
    billed: verdict.billed,
    ...(reservedCharge === 0 ? {} : { reserved: reservedCharge }),
    charge: chargeOf(
      pricingOf(allowance ?? {}),
      allowance?.included ?? null,
      used + reserved,
      amount,
    ),
  });
};

/**
 * The alerts a usage fact reaches. One per configured threshold the period has
 * now passed and has not latched, delivered with the fact that crossed it: an
 * alert alone would have no usage event to attach to, and a redelivery would
 * fire it twice (ADR 0038).
 */
const alertsFor = (
  state: SubscribedState,
  feature: string,
  usedAfter: number,
  firedAt: DateTime.Utc,
): ReadonlyArray<UsageAlertFired> => {
  const fired = alertsFiredOf(state, feature);

  return alertThresholdsOf(state, feature)
    .filter((at) => usedAfter >= at && !fired.includes(at))
    .map((at) => new UsageAlertFired({ feature, at, usedAfter, firedAt }));
};

/**
 * The refusal a `SetBillingControls` payload means, or `null` when it is valid.
 * The catalog facts ride the command, so a control survives a plan that does
 * not grant its feature; `decide` never reads the catalog (ADR 0038).
 */
const controlsRefusalOf = (command: {
  readonly billingControls?: BillingControls;
  readonly features: Readonly<Record<string, ControlFeature>>;
}): ControlsFeatureUnknown | ControlsFeatureNotPriced | ControlsDuplicate | null => {
  const controls = normalizeBillingControls(command.billingControls);

  if (controls === undefined) return null;

  const seenLimits = new Set<string>();

  for (const limit of controls.spendLimits ?? []) {
    if (seenLimits.has(limit.featureId)) {
      return new ControlsDuplicate({ list: "spendLimits", featureId: limit.featureId });
    }

    seenLimits.add(limit.featureId);

    const fact = command.features[limit.featureId];

    if (fact === undefined) return new ControlsFeatureUnknown({ featureId: limit.featureId });

    if (!fact.priced) return new ControlsFeatureNotPriced({ featureId: limit.featureId });
  }

  const seenAlerts = new Set<string>();

  for (const alert of controls.usageAlerts ?? []) {
    const key = `${alert.featureId}@${alert.at}`;

    if (seenAlerts.has(key)) {
      return new ControlsDuplicate({
        list: "usageAlerts",
        featureId: alert.featureId,
        at: alert.at,
      });
    }

    seenAlerts.add(key);

    if (command.features[alert.featureId] === undefined) {
      return new ControlsFeatureUnknown({ featureId: alert.featureId });
    }
  }

  return null;
};

/** The money evidence a capacity `Limit` verdict carries, in the command's split. */
const spendLimitRefusalOf = (
  verdict: Extract<Capacity, { readonly _tag: "Limit" }>,
  state: SubscribedState,
  feature: string,
  amount: number,
): SpendLimitExceeded => {
  const allowance = state.allowances[feature];
  const used = usedOf(state, feature);
  const reserved = reservedOf(state, feature);

  const reservedCharge = chargeOf(
    pricingOf(allowance ?? {}),
    allowance?.included ?? null,
    used,
    reserved,
  );

  return new SpendLimitExceeded({
    feature,
    limit: verdict.limit,
    billed: verdict.billed,
    ...(reservedCharge === 0 ? {} : { reserved: reservedCharge }),
    charge: chargeOf(
      pricingOf(allowance ?? {}),
      allowance?.included ?? null,
      used + reserved,
      amount,
    ),
  });
};

/** Every refusal a capacity verdict means for `TrackUsage`. */
type UsageRefusal =
  | AllowanceExceeded
  | StandingBlocksUsage
  | SpendCapExceeded
  | MoneyCapExceeded
  | SpendLimitExceeded
  | CreditExceeded;

/** The rejection a capacity verdict means for `TrackUsage`, or `null` when it allowed. */
const usageRefusalOf = (
  verdict: Capacity,
  state: SubscribedState,
  feature: string,
  amount: number,
): UsageRefusal | null => {
  switch (verdict._tag) {
    case "Allowed":
      return null;
    case "Standing":
      return new StandingBlocksUsage({ standing: verdict.standing, status: state.status });
    case "Remaining": {
      const included = state.allowances[feature]?.included;

      return new AllowanceExceeded({
        feature,
        included: typeof included === "number" ? included : 0,
        used: usedOf(state, feature),
        requested: verdict.requested,
        remaining: verdict.remaining,
      });
    }

    case "Ceiling":
      return new SpendCapExceeded({
        feature,
        cap: verdict.cap,
        used: usedOf(state, feature),
        reserved: reservedOf(state, feature),
        requested: verdict.requested,
      });
    case "Money":
      return moneyCapRefusalOf(verdict, state, feature, amount);
    case "Limit":
      return spendLimitRefusalOf(verdict, state, feature, amount);
    case "Credits": {
      const reserved = reservedCreditsOf(state);

      return new CreditExceeded({
        feature,
        cost: verdict.cost,
        balance: state.credits,
        ...(reserved === 0 ? {} : { reserved }),
      });
    }
  }
};

/** Every refusal a capacity verdict means for `Hold`. */
type HoldRefusal =
  | HoldExceeded
  | StandingBlocksUsage
  | SpendCapExceeded
  | MoneyCapExceeded
  | SpendLimitExceeded;

/** The rejection a capacity verdict means for `Hold`, or `null` when it allowed. */
const holdRefusalOf = (
  verdict: Capacity,
  state: SubscribedState,
  feature: string,
  amount: number,
): HoldRefusal | null => {
  switch (verdict._tag) {
    case "Allowed":
      return null;
    case "Standing":
      return new StandingBlocksUsage({ standing: verdict.standing, status: state.status });
    case "Remaining":
      return new HoldExceeded({
        feature,
        requested: verdict.requested,
        held: 0,
        remaining: verdict.remaining,
      });
    case "Credits":
      return new HoldExceeded({
        feature,
        requested: verdict.cost,
        held: 0,
        remaining: verdict.available,
      });
    case "Ceiling":
      return new SpendCapExceeded({
        feature,
        cap: verdict.cap,
        used: usedOf(state, feature),
        reserved: reservedOf(state, feature),
        requested: verdict.requested,
      });
    case "Money":
      return moneyCapRefusalOf(verdict, state, feature, amount);
    case "Limit":
      return spendLimitRefusalOf(verdict, state, feature, amount);
  }
};

/**
 * One account's standing: subscription state and usage counters in one
 * aggregate, so a `TrackUsage` that would exceed a blocking allowance is
 * refused in the same transaction that would have recorded it.
 */
export class Subscription extends Domain.Aggregate("Subscription", {
  id: AccountId,
  state: SubscriptionState,
  initial: initialSubscriptionState,
  commands: [
    StartTrial,
    Subscribe,
    ChangeTier,
    TrackUsage,
    RecordPayment,
    RecordPaymentFailure,
    EnterGrace,
    Recover,
    Hold,
    SettleHold,
    ReleaseHold,
    HoldElapsed,
    RecordProrationInvoice,
    GrantBalance,
    ExpireGrant,
    GrantCredits,
    PurchaseCredits,
    Refund,
    ReverseRefund,
    RecordTopUpFailure,
    RetryTopUp,
    TopUpCooldownElapsed,
    ConsumeCredits,
    CancelImmediately,
    ScheduleCancellation,
    ScheduleTierChange,
    WithdrawTierChange,
    Resume,
    ClosePeriod,
    Expire,
    ExtendTrial,
    AttachProviderRef,
    PeriodEnded,
    GraceElapsed,
    DunningRetry,
    ResetAllowance,
    SetQuantity,
    SetUsage,
    SetBillingControls,
    RecordQuantityProrationInvoice,
  ],
  decide: {
    StartTrial: (state, command, { id, now }) => {
      if (state._tag === "Subscribed" && state.trialUsed) {
        return new TrialAlreadyUsed({ account: id });
      }

      if (emptyAllowances(command.allowances)) {
        return new PlanNotInCatalog({ tier: command.tier });
      }

      const currentCurrency = state._tag === "Subscribed" ? state.currency : undefined;
      const currency = command.price?.currency ?? unitPriceCurrencyOf(command.allowances);

      if (currentCurrency !== undefined && currency !== undefined && currentCurrency !== currency) {
        return new CurrencyMismatch({ expected: currentCurrency, actual: currency });
      }

      // The deadline is the end of the first period, so it has to be ahead of
      // the start. A trial that ends before it begins opens a period the engine
      // would close on its next tick, and every `resetsAt` after it inherits the
      // mistake.
      if (DateTime.toEpochMillis(command.trialEndsAt) <= DateTime.toEpochMillis(now)) {
        return new TrialDeadlineNotLater({ current: now, requested: command.trialEndsAt });
      }

      // A pack the account already bought survives a new activation; the
      // plan's own grant is the only part that starts fresh.
      const prepaid = prepaidCreditsOf(state);

      return [
        new TrialStarted({
          ...activationOf({
            tier: command.tier,
            allowances: command.allowances,
            credits: command.credits + prepaid,
            prepaidCredits: prepaid,
            creditsExpire: command.creditsExpire,
            ...(command.topUp === undefined ? {} : { topUp: command.topUp }),
            rates: command.rates,
            ...(command.price === undefined ? {} : { price: command.price }),
            period: {
              start: now,
              end: command.trialEndsAt,
              anchorTz: command.anchorTz ?? "UTC",
            },
            previousCurrency: currentCurrency,
            statusAfter: "trialing",
          }),
          trialEndsAt: command.trialEndsAt,
        }),
      ];
    },
    Subscribe: (state, command, { id, now }) => {
      if (emptyAllowances(command.allowances)) {
        return new PlanNotInCatalog({ tier: command.tier });
      }

      // A second activation on an open standing would reset the period, the
      // counters and the holds. Only a terminal standing may be replaced by a
      // fresh purchase; an active change is `ChangeTier`, and a trial is
      // `StartTrial`.
      if (state._tag === "Subscribed" && !isTerminalStatus(state.status)) {
        return new AlreadySubscribed({ account: id, status: state.status });
      }

      const currentCurrency = state._tag === "Subscribed" ? state.currency : undefined;
      const priceCurrency = command.price?.currency ?? unitPriceCurrencyOf(command.allowances);

      if (
        currentCurrency !== undefined &&
        priceCurrency !== undefined &&
        currentCurrency !== priceCurrency
      ) {
        return new CurrencyMismatch({ expected: currentCurrency, actual: priceCurrency });
      }

      const interval =
        command.price?.interval ?? (state._tag === "Subscribed" ? state.interval : "month");

      const period = periodFrom(now, interval, command.anchorTz ?? "UTC");
      // A pack the account already bought survives a new activation; the
      // plan's own grant is the only part that starts fresh.
      const prepaid = prepaidCreditsOf(state);

      return [
        new SubscriptionActivated({
          ...activationOf({
            tier: command.tier,
            allowances: command.allowances,
            credits: command.credits + prepaid,
            prepaidCredits: prepaid,
            creditsExpire: command.creditsExpire,
            ...(command.topUp === undefined ? {} : { topUp: command.topUp }),
            rates: command.rates,
            ...(command.price === undefined ? {} : { price: command.price }),
            ...(command.chargeId === undefined ? {} : { chargeId: command.chargeId }),
            period,
            previousCurrency: currentCurrency,
            statusAfter: "active",
          }),
          interval,
        }),
      ];
    },
    ChangeTier: (state, command, { id, now }) => {
      if (emptyAllowances(command.allowances)) {
        return new PlanNotInCatalog({ tier: command.tier });
      }

      const current = subscribed(state, id);

      if (Schema.is(NotSubscribed)(current)) return current;

      // A terminal standing has no open period to move through. The tier is
      // replaced by a new activation, not by a change that leaves it expired.
      if (isTerminalStatus(current.status)) {
        return new StandingEnded({ account: id, status: current.status });
      }

      for (const [feature, allowance] of Object.entries(command.allowances)) {
        // Only a blocking allowance can be oversubscribed: below its count,
        // every later request is refused and the read model reports a negative
        // `remaining` for a feature that stops at zero. A billed or allowed
        // allowance is in the ordinary state when `used > included` — that is
        // what overage means — so the change is allowed, and it is how a
        // mid-period price change reaches the standing. Open holds are owed
        // too: moving below them oversubscribes the allowance just the same.
        //
        // The two ceilings are kept across a change as well, and a ceiling
        // already passed is a standing no command can leave: every later
        // `TrackUsage` and `Hold` refuses until the period resets the counters.
        // Money and units are refused separately because the evidence a console
        // shows is a different sentence in each.
        const refusal = downgradeOf(allowance, {
          used: usedOf(current, feature),
          reserved: reservedOf(current, feature),
          billed: billedOf(current, feature),
        });

        switch (refusal._tag) {
          case "Allowed":
            break;
          case "Usage":
            return new DowngradeBelowUsage({
              feature,
              included: refusal.included,
              used: refusal.used,
              ...(refusal.reserved === undefined ? {} : { reserved: refusal.reserved }),
            });
          case "Spend":
            return new DowngradeBelowSpend({
              feature,
              moneyCap: refusal.moneyCap,
              billed: refusal.billed,
            });
          case "Ceiling":
            return new DowngradeBelowCeiling({
              feature,
              ceiling: refusal.ceiling,
              used: refusal.used,
              ...(refusal.reserved === undefined ? {} : { reserved: refusal.reserved }),
            });
        }
      }

      const priceCurrency = command.price?.currency ?? unitPriceCurrencyOf(command.allowances);

      if (
        current.currency !== undefined &&
        priceCurrency !== undefined &&
        current.currency !== priceCurrency
      ) {
        return new CurrencyMismatch({ expected: current.currency, actual: priceCurrency });
      }

      // The proration is money the event will carry, so it is judged here, in
      // the pure decision, against the prices and the period the model holds.
      // A caller that sends a number the model did not compute is refused
      // rather than trusted: an unverifiable charge is worse than no charge.
      const expected = prorate({
        from: current.price,
        to: command.price,
        period: { start: current.period.start, end: current.period.end },
        at: now,
      });

      if (sameProration(expected, command.proration ?? null) === false) {
        return new ProrationMismatch({
          expected,
          actual: command.proration ?? null,
        });
      }

      return [
        new PlanChanged({
          tier: command.tier,
          allowances: command.allowances,
          remaining: remainingAfterChange(current, command.allowances),
          ...((priceCurrency ?? current.currency) === undefined
            ? {}
            : { currency: (priceCurrency ?? current.currency)! }),
          ...(command.price?.interval === undefined ? {} : { interval: command.price.interval }),
          // A tier change does not re-grant: the pool the account already holds
          // is what the event records, while the expiry rule and the rate cards
          // move to the new tier's. The one-off part stays protected.
          credits: current.credits,
          ...carriedPrepaidOf(current, current.credits),
          creditsExpire: command.creditsExpire,
          ...(command.topUp === undefined ? {} : { topUp: command.topUp }),
          rates: command.rates,
          ...(current.price === undefined ? {} : { priceBefore: current.price }),
          ...(command.price === undefined ? {} : { priceAfter: command.price }),
          ...(command.proration === undefined ? {} : { proration: command.proration }),
          ...(() => {
            const resetAt = resetWindowsOf(command.allowances, now);

            return Object.keys(resetAt).length === 0 ? {} : { resetAt };
          })(),
        }),
      ];
    },
    TrackUsage: (state, command, { now }) => {
      if (state._tag === "Unsubscribed") {
        // A pack can be spent before a plan exists. The purchase captured the
        // catalog's rate cards, so this is the same credit math as a standing,
        // with the whole pool spendable and no allowance to consult.
        const rates = state.rates?.[command.feature];

        if (rates === undefined) {
          return new StandingBlocksUsage({ standing: "blocked", status: "none" });
        }

        if (command.amount <= 0) return [];

        if (command.dedupeKey !== undefined && state.dedupeKeys?.[command.dedupeKey] === true) {
          return [];
        }

        const cost =
          command.amount *
          creditRateOf(rates, { dimension: command.dimension, properties: command.properties });

        const balance = state.credits ?? 0;

        if (cost > balance) {
          return new CreditExceeded({ feature: command.feature, cost, balance });
        }

        return [
          new UsageRecorded({
            feature: command.feature,
            amount: command.amount,
            cost,
            creditsAfter: balance - cost,
            usedAfter: (state.usage?.[command.feature] ?? 0) + cost,
            remainingAfter: balance - cost,
            ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
          }),
        ];
      }

      const allowance = state.allowances[command.feature];

      // A flag is granted, not metered, and a quantity is occupied, not spent.
      // Both are refused before the capacity rule so a seat out of balance says
      // what it is instead of looking like a spent allowance.
      if (allowance !== undefined && isFlagGrant(allowance)) {
        return new FeatureNotMetered({ feature: command.feature });
      }

      if (allowance !== undefined && isQuantityGrant(allowance)) {
        return new FeatureNotConsumable({ feature: command.feature });
      }

      const verdict = capacityOf({
        standing: standingOf(state.status),
        feature: judgedOf(state, command.feature),
        ask: {
          amount: command.amount,
          ...(command.dimension === undefined ? {} : { dimension: command.dimension }),
          ...(command.properties === undefined ? {} : { properties: command.properties }),
        },
      });

      if (verdict._tag === "Standing") {
        return new StandingBlocksUsage({ standing: verdict.standing, status: state.status });
      }

      if (command.amount <= 0) return [];

      if (command.dedupeKey !== undefined && state.dedupeKeys[command.dedupeKey] === true) {
        return [];
      }

      const refusal = usageRefusalOf(verdict, state, command.feature, command.amount);

      if (refusal !== null) return refusal;
      // A credit-priced feature spends the account's pool: the event carries
      // the cost and the balance after it, so the pool is a fold of the log.
      const rates = state.rates[command.feature];

      if (rates !== undefined) {
        const cost =
          command.amount *
          creditRateOf(rates, { dimension: command.dimension, properties: command.properties });

        return [
          new UsageRecorded({
            feature: command.feature,
            amount: command.amount,
            cost,
            creditsAfter: state.credits - cost,
            // `used` counts credits spent on this feature, and `remaining` is
            // the one pool every credit-priced feature shares.
            usedAfter: usedOf(state, command.feature) + cost,
            remainingAfter: state.credits - cost,
            ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
          }),
        ];
      }

      const used = usedOf(state, command.feature);
      const remaining = remainingOf(state, command.feature);
      const pricing = pricingOf(allowance ?? {});
      const charge = chargeOf(pricing, allowance?.included ?? null, used, command.amount);
      const billed = billedOf(state, command.feature);

      return [
        new UsageRecorded({
          feature: command.feature,
          amount: command.amount,
          // A feature counted in its own units spends no credits.
          cost: 0,
          creditsAfter: state.credits,
          usedAfter: used + command.amount,
          remainingAfter: remainingAfterSpending(remaining, command.amount),
          ...(pricing === null
            ? {}
            : {
                charge,
                billedAfter: billed + charge,
                // The lines this event was priced at, and the part of it past
                // the free grant. Captured here because `used` is the only
                // place the running total lives: the close never has to work
                // out which units the grant covered.
                ...(soleUnitPriceOf(pricing) === null
                  ? {
                      priced: pricedOf(pricing, allowance?.included ?? null, used, command.amount),
                    }
                  : { unitPrice: soleUnitPriceOf(pricing)! }),
                billable: billableUnitsOf(allowance?.included ?? null, used, command.amount),
              }),
          ...(Object.keys(grantsForSpend(state, command.feature, command.amount)).length === 0
            ? {}
            : { grantsUsed: grantsForSpend(state, command.feature, command.amount) }),
          ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
        }),
        ...alertsFor(state, command.feature, used + command.amount, now),
      ];
    },
    SetBillingControls: (state, command) => {
      const refusal = controlsRefusalOf(command);

      if (refusal !== null) return refusal;

      const billingControls = normalizeBillingControls(command.billingControls);

      if (controlsKey(billingControls) === controlsKey(state.billingControls)) return [];

      return [new BillingControlsSet(billingControls === undefined ? {} : { billingControls })];
    },
    SetQuantity: (state, command, { id, now }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });
      const allowance = state.allowances[command.feature];

      if (allowance === undefined || !isQuantityGrant(allowance)) {
        return new FeatureNotConsumable({ feature: command.feature });
      }

      if (command.quantity < 0) {
        return new QuantityInvalid({ feature: command.feature, quantity: command.quantity });
      }

      const included = typeof allowance.included === "number" ? allowance.included : 0;

      if (allowance.cap !== undefined && command.quantity > allowance.cap) {
        return new QuantityCapExceeded({
          feature: command.feature,
          cap: allowance.cap,
          quantity: command.quantity,
        });
      }

      if (allowance.overage === "block" && command.quantity > included) {
        return new QuantityExceeded({
          feature: command.feature,
          included,
          quantity: command.quantity,
        });
      }

      const before = quantityOf(state, command.feature, allowance);

      if (before === command.quantity) return [];

      // A blocked standing may give seats back; it may not take more.
      if (!allowsUsage(state.status) && command.quantity > before) {
        return new StandingBlocksUsage({
          standing: standingOf(state.status),
          status: state.status,
        });
      }

      const pricing = pricingOf(allowance);
      const unitPrice = pricing === null ? null : soleUnitPriceOf(pricing);

      const proration =
        allowance.prorate === "period_end" || unitPrice === null
          ? null
          : prorateQuantity({
              from: before,
              to: command.quantity,
              included,
              unitPrice,
              period: state.period,
              at: now,
            });

      return [
        new QuantityChanged({
          feature: command.feature,
          quantityBefore: before,
          quantityAfter: command.quantity,
          ...(proration === null ? {} : { proration, prorationId: command.dedupeKey }),
        }),
      ];
    },
    SetUsage: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });
      const allowance = state.allowances[command.feature];

      if (allowance === undefined || !isQuantityGrant(allowance)) {
        return new FeatureNotConsumable({ feature: command.feature });
      }

      if (command.usage < 0) {
        return new UsageInvalid({ feature: command.feature, usage: command.usage });
      }

      const before = occupiedOf(state, command.feature);

      if (before === command.usage) return [];

      // A blocked standing may free a seat; it may not occupy a new one.
      if (!allowsUsage(state.status) && command.usage > before) {
        return new StandingBlocksUsage({
          standing: standingOf(state.status),
          status: state.status,
        });
      }

      return [
        new UsageSet({
          feature: command.feature,
          occupiedBefore: before,
          occupiedAfter: command.usage,
          remainingAfter: quantityOf(state, command.feature, allowance) - command.usage,
        }),
      ];
    },
    RecordQuantityProrationInvoice: (state, command, { id }) => {
      if (state._tag !== "Subscribed") {
        return new NoQuantityProrationDue({
          account: id,
          prorationId: command.prorationId,
          reason: "none",
        });
      }

      const entry = state.quantityProrations?.[command.prorationId];

      if (entry === undefined) {
        return new NoQuantityProrationDue({
          account: id,
          prorationId: command.prorationId,
          reason: "none",
        });
      }

      if (entry.invoiceId !== undefined) {
        return new NoQuantityProrationDue({
          account: id,
          prorationId: command.prorationId,
          reason: "billed",
        });
      }

      return [
        new QuantityProrationInvoiced({
          prorationId: command.prorationId,
          invoiceId: command.invoiceId,
          amount: command.amount,
          currency: command.currency,
        }),
      ];
    },
    RecordPayment: (state, command) => {
      if (state._tag !== "Subscribed" || state.status !== "grace") {
        return new NotInGrace({ status: statusOf(state) });
      }

      return [
        new PaymentRecorded({
          amount: command.amount,
          currency: command.currency,
          ...(command.chargeId === undefined ? {} : { chargeId: command.chargeId }),
          statusAfter: "active",
        }),
      ];
    },
    RecordPaymentFailure: (state, command, { now }) => {
      if (state._tag !== "Subscribed") return [];

      if (state.status === "expired" || state.status === "canceled") return [];

      const graceUntil =
        state.graceUntil !== undefined &&
        DateTime.toEpochMillis(state.graceUntil) > DateTime.toEpochMillis(command.graceUntil)
          ? state.graceUntil
          : command.graceUntil;

      // A failure that opens a new run starts the ladder now; a second failure
      // in the same run keeps the first one, so every rung stays measured from
      // the failure the deployment is actually dunning.
      const dunningStartedAt = state.dunningAttempts === 0 ? now : (state.dunningStartedAt ?? now);

      return [
        new PaymentFailed({
          reason: command.reason,
          graceUntilAfter: graceUntil,
          statusAfter: "grace",
          attempt: state.dunningAttempts + 1,
          dunningStartedAt,
        }),
      ];
    },
    DunningRetry: (state, command, { now }) => {
      if (state._tag !== "Subscribed" || state.status !== "grace") return [];

      if (state.graceUntil === undefined) return [];

      // The deadline is the hard stop: a retry that is only being handled after
      // grace passed belongs to `GraceElapsed`, not to the card.
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(state.graceUntil)) return [];

      if (state.dunningAttempts !== command.afterAttempt) return [];

      if (state.dunningStartedAt === undefined) return [];

      if (
        DateTime.toEpochMillis(state.dunningStartedAt) !== DateTime.toEpochMillis(command.startedAt)
      ) {
        return [];
      }

      const price = state.price;

      if (price === undefined) return [];

      return [
        new DunningRetryDue({
          attempt: state.dunningAttempts + 1,
          startedAt: state.dunningStartedAt,
          amount: price.amount,
          currency: price.currency,
        }),
      ];
    },
    EnterGrace: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      if (state.status === "grace") return new AlreadyInGrace();

      if (!canEnterGrace(state.status)) return new NotInGrace({ status: state.status });

      return [new GraceEntered({ graceUntil: command.graceUntil, statusAfter: "grace" })];
    },
    Recover: (state) => {
      if (state._tag !== "Subscribed" || state.status !== "grace") {
        return new NotInGrace({ status: statusOf(state) });
      }

      return [new Recovered({ statusAfter: "active" })];
    },
    Hold: (state, command, { now }) => {
      if (state._tag === "Unsubscribed") {
        return new StandingBlocksUsage({ standing: "blocked", status: "none" });
      }

      if (!allowsUsage(state.status)) {
        return new StandingBlocksUsage({
          standing: standingOf(state.status),
          status: state.status,
        });
      }

      // A flag has no counter and no pool: it is granted or it is not. A
      // quantity is occupied, not held. Both are refused before the capacity
      // rule, so a seat is never mistaken for a spent allowance.
      const allowance = state.allowances[command.feature];
      const rates = state.rates[command.feature];

      if (allowance !== undefined && isFlagGrant(allowance)) {
        return new FeatureNotMetered({ feature: command.feature });
      }

      if (allowance !== undefined && isQuantityGrant(allowance)) {
        return new FeatureNotConsumable({ feature: command.feature });
      }

      const verdict = capacityOf({
        standing: standingOf(state.status),
        feature: judgedOf(state, command.feature),
        ask: {
          amount: command.amount,
          ...(command.dimension === undefined ? {} : { dimension: command.dimension }),
          ...(command.properties === undefined ? {} : { properties: command.properties }),
        },
      });

      if (verdict._tag === "Standing") {
        return new StandingBlocksUsage({ standing: verdict.standing, status: state.status });
      }

      // A hold with the id this standing already has is a replay: the retry
      // holds once, and the caller gets the same id back.
      if (holdOf(state, command.holdId) !== null) return [];

      if (command.amount <= 0) return [];

      if (command.dedupeKey !== undefined && state.dedupeKeys[command.dedupeKey] === true) {
        return [];
      }

      const refusal = holdRefusalOf(verdict, state, command.feature, command.amount);

      if (refusal !== null) return refusal;

      // The rate is captured here, so the bill at settle is the price the work
      // was priced at, not whatever the catalog says when it finishes.
      const rate =
        rates === undefined
          ? 0
          : creditRateOf(rates, {
              dimension: command.dimension,
              properties: command.properties,
            });

      const cost = command.amount * rate;
      const remaining = availableOf(state, command.feature);
      // A credit-priced hold takes credits out of the pool; a counted one takes
      // its own units.
      const held = rates === undefined ? command.amount : cost;

      return [
        new UsageReserved({
          holdId: command.holdId,
          feature: command.feature,
          amount: command.amount,
          ...(command.dimension === undefined ? {} : { dimension: command.dimension }),
          rate,
          cost,
          at: now,
          expiresAt: command.expiresAt ?? defaultHoldExpiry(now),
          remainingAfter: remainingAfterSpending(remaining, held),
          ...(Object.keys(grantsForSpend(state, command.feature, command.amount)).length === 0
            ? {}
            : { grantsUsed: grantsForSpend(state, command.feature, command.amount) }),
          ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
        }),
      ];
    },
    SettleHold: (state, command, { now }) => {
      if (state._tag === "Unsubscribed") return new HoldUnknown({ holdId: command.holdId });
      const hold = holdOf(state, command.holdId);

      if (hold === null) return new HoldUnknown({ holdId: command.holdId });

      // The work is already billed: a replay records nothing rather than
      // charging twice, and the id makes the command id derivable.
      if (hold.status === "settled") return [];

      // A released or swept hold was never billed. A settle after the fact is
      // an idempotent no-op, not a refusal that makes a cleanup look like a
      // failed charge.
      if (hold.status === "released" || hold.status === "expired") return [];

      if (!allowsUsage(state.status)) {
        return new StandingBlocksUsage({
          standing: standingOf(state.status),
          status: state.status,
        });
      }

      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(hold.expiresAt)) {
        return new HoldExpired({
          holdId: hold.id,
          feature: hold.feature,
          expiresAt: hold.expiresAt,
          now,
        });
      }

      const billed = command.amount ?? hold.amount;

      if (billed < 0 || billed > hold.amount) {
        return new HoldExceeded({
          holdId: hold.id,
          feature: hold.feature,
          requested: billed,
          held: hold.amount,
          remaining: availableOf(state, hold.feature) ?? 0,
        });
      }

      // Whatever was not billed returns in the same command, so the common
      // path is two calls and there is no third one to forget.
      const released = hold.amount - billed;
      const creditPriced = state.rates[hold.feature] !== undefined;
      const cost = billed * hold.rate;
      const allowance = state.allowances[hold.feature];
      const used = usedOf(state, hold.feature);
      const pricing = pricingOf(allowance ?? {});
      const charge = chargeOf(pricing, allowance?.included ?? null, used, billed);
      const billedMoney = billedOf(state, hold.feature);
      // The other open holds are promises to bill too; this one is being
      // billed now, so it is in `charge`, not in `reservedCharge`.
      const otherReserved = Math.max(0, reservedOf(state, hold.feature) - hold.amount);

      const reservedCharge = chargeOf(
        pricing,
        allowance?.included ?? null,
        used + billed,
        otherReserved,
      );

      // The other open holds are promises to bill too; this one is being
      // billed now, so it is in `charge`, not in `reservedCharge`. The money
      // rule judges the total, and the evidence stays this command's own split.
      const overflow = moneyOverflowOf(
        { ...judgedOf(state, hold.feature), reserved: otherReserved },
        billed,
      );

      if (overflow !== null) {
        return new MoneyCapExceeded({
          feature: hold.feature,
          cap: overflow.cap,
          billed: overflow.billed,
          ...(reservedCharge === 0 ? {} : { reserved: reservedCharge }),
          charge,
        });
      }

      // The hold took its units (or credits) out when it was placed; what it
      // did not bill comes back here. An unlimited allowance stays `null`.
      const available = availableOf(state, hold.feature);

      const alerts = alertsFor(state, hold.feature, used + (creditPriced ? cost : billed), now);

      const remaining = remainingAfterRelease(
        available,
        creditPriced ? released * hold.rate : released,
      );

      return [
        new UsageRecorded({
          feature: hold.feature,
          amount: billed,
          // The rate captured at hold time, not the catalog's current one.
          cost,
          creditsAfter: state.credits - cost,
          // A credit-priced feature counts credits spent; a counted one counts
          // its units.
          usedAfter: usedOf(state, hold.feature) + (creditPriced ? cost : billed),
          // The units left `remaining` when they were held; the released ones
          // come back here.
          remainingAfter: remaining,
          ...(pricing === null
            ? {}
            : {
                charge,
                billedAfter: billedMoney + charge,
                ...(soleUnitPriceOf(pricing) === null
                  ? { priced: pricedOf(pricing, allowance?.included ?? null, used, billed) }
                  : { unitPrice: soleUnitPriceOf(pricing)! }),
                billable: billableUnitsOf(allowance?.included ?? null, used, billed),
              }),
          ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
          // A feature with grants needs the marker: the hold already took its
          // grant units when it was placed, so the settle must not take them
          // again. A feature without grants keeps the event unchanged.
          ...(grantsOf(state, hold.feature).length === 0 ? {} : { holdId: hold.id }),
        }),
        new UsageSettled({
          holdId: hold.id,
          feature: hold.feature,
          amount: billed,
          released,
          cost: hold.cost,
          remainingAfter: remaining,
          ...(hold.grantsUsed === undefined
            ? {}
            : { grantsReturned: grantsReturnedFor(hold.grantsUsed, released) }),
        }),
        ...alerts,
      ];
    },
    ReleaseHold: (state, command) => {
      if (state._tag === "Unsubscribed") return new HoldUnknown({ holdId: command.holdId });
      const hold = holdOf(state, command.holdId);

      if (hold === null) return new HoldUnknown({ holdId: command.holdId });

      // A released hold is a replay; a settled one was billed, so the units
      // are not there to give back.
      if (hold.status === "released" || hold.status === "expired") return [];

      if (hold.status === "settled") {
        return new HoldSettled({ holdId: hold.id, feature: hold.feature });
      }

      // A late release is a cleanup, not a charge: expiry does not refuse it.
      return [releaseEvent(state, hold, "released")];
    },
    HoldElapsed: (state, command, { now }) => {
      // The deadline is scheduled, so none of these is an operator's mistake:
      // an unknown id, a hold that already closed, and a fire before the
      // deadline all record nothing.
      if (state._tag === "Unsubscribed") return [];
      const hold = holdOf(state, command.holdId);

      if (hold === null || hold.status !== "open") return [];

      if (DateTime.toEpochMillis(now) < DateTime.toEpochMillis(hold.expiresAt)) return [];

      // Releasing here is the same cleanup `ReleaseHold` performs, but the
      // reason is the deadline: the hold expired rather than being released.
      return [releaseEvent(state, hold, "expired")];
    },
    RecordProrationInvoice: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NoProrationDue({ account: id, reason: "none" });
      const proration = state.proration;

      // Only a positive `due` is money to collect; a credit is applied by the
      // next period, so there is nothing to invoice.
      if (proration === undefined || proration.due <= 0) {
        return new NoProrationDue({ account: id, reason: "none" });
      }

      if (state.prorationInvoice !== undefined) {
        return new NoProrationDue({ account: id, reason: "billed" });
      }

      return [
        new ProrationInvoiced({
          invoiceId: command.invoiceId,
          amount: command.amount,
          currency: command.currency,
        }),
      ];
    },
    GrantCredits: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      if (command.amount <= 0) return [];

      return [
        new CreditsGranted({
          amount: command.amount,
          balanceAfter: state.credits + command.amount,
        }),
      ];
    },
    GrantBalance: (state, command, { id, now, commandId }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      const allowance = state.allowances[command.feature];

      if (state.rates[command.feature] !== undefined) {
        return new FeaturePricedInCredits({ feature: command.feature });
      }

      if (allowance !== undefined && isQuantityGrant(allowance)) {
        return new FeatureNotConsumable({ feature: command.feature });
      }

      if (allowance !== undefined && isFlagGrant(allowance)) {
        return new FeatureNotMetered({ feature: command.feature });
      }

      // A grant needs a count to add to; an unlimited allowance has none.
      if (allowance?.included === "unlimited") {
        return new FeatureNotCounted({ feature: command.feature });
      }

      if (command.granted <= 0) return [];

      if (
        command.expiresAt !== undefined &&
        DateTime.toEpochMillis(command.expiresAt) <= DateTime.toEpochMillis(now)
      ) {
        return new GrantExpiryNotLater({ expiresAt: command.expiresAt, now });
      }

      return [
        new BalanceGranted({
          feature: command.feature,
          grantId: commandId,
          granted: command.granted,
          ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
          planId: state.tier,
          remainingAfter: (remainingOf(state, command.feature) ?? 0) + command.granted,
        }),
      ];
    },
    ExpireGrant: (state, command, { now }) => {
      if (state._tag !== "Subscribed") return [];

      const grant = state.grants?.[command.grantId];

      if (grant === undefined || grant.feature !== command.feature) return [];

      // A scheduled deadline is not an operator's mistake: a grant with no
      // deadline, a deadline not yet reached, and a grant already gone all
      // record nothing.
      if (
        grant.expiresAt === undefined ||
        DateTime.toEpochMillis(now) < DateTime.toEpochMillis(grant.expiresAt)
      ) {
        return [];
      }

      return [
        new BalanceExpired({
          feature: grant.feature,
          grantId: grant.id,
          amount: grant.remaining,
          balanceAfter: (remainingOf(state, grant.feature) ?? 0) - grant.remaining,
        }),
      ];
    },
    PurchaseCredits: (state, command) => {
      // A pack is bought with or without a plan: the pool can exist alone, and
      // a later subscribe carries it in. The purchase never creates a standing.
      if (command.amount <= 0) return [];

      return [
        new CreditsPurchased({
          tier: command.tier,
          amount: command.amount,
          ...(command.price === undefined ? {} : { price: command.price }),
          ...(command.rates === undefined ? {} : { rates: command.rates }),
          ...(command.invoiceId === undefined ? {} : { invoiceId: command.invoiceId }),
          ...(command.chargeId === undefined ? {} : { chargeId: command.chargeId }),
          ...(command.cooldownUntil === undefined ? {} : { cooldownUntil: command.cooldownUntil }),
          balanceAfter: creditsOf(state) + command.amount,
          prepaidAfter: prepaidCreditsOf(state) + command.amount,
        }),
      ];
    },
    Refund: (state, command, { commandId }) => {
      // A non-positive refund records nothing, like every other money command.
      if (command.amount <= 0) return [];
      // The ceiling is the money the log knows: a refund cannot exceed what
      // this account was charged in its currency, minus what already went back.
      const refundable = refundableOf(state, command.currency);

      if (command.amount > refundable) {
        return new RefundExceedsCharged({
          currency: command.currency,
          charged: refundable + (refundedOf(state)[command.currency] ?? 0),
          refunded: refundedOf(state)[command.currency] ?? 0,
          requested: command.amount,
        });
      }

      // A revocation is a second ceiling and a second fact. Both are checked
      // before either is recorded, so a refused refund sends no money and burns
      // no credits (ADR 0032).
      const revoke = command.revokeCredits ?? 0;
      const reserved = state._tag === "Subscribed" ? reservedCreditsOf(state) : 0;

      if (revoke > 0 && revoke > (state._tag === "Subscribed" ? state.credits - reserved : 0)) {
        return new CreditExceedsBalance({
          balance: state._tag === "Subscribed" ? state.credits : 0,
          requested: revoke,
          ...(reserved === 0 ? {} : { reserved }),
        });
      }

      return [
        new RefundRecorded({
          chargeId: command.chargeId,
          refundId: command.refundId,
          amount: command.amount,
          currency: command.currency,
          commandId,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
          refundedAfter: (refundedOf(state)[command.currency] ?? 0) + command.amount,
        }),
        // The money first, then the pool: a reader sees what went back before it
        // sees what stopped being spendable.
        ...(revoke <= 0 || state._tag !== "Subscribed"
          ? []
          : [new CreditsConsumed({ amount: revoke, balanceAfter: state.credits - revoke })]),
      ];
    },
    RecordTopUpFailure: (state, command, { commandId, now }) => {
      // A failure with no pack to name is a policy that lost a race with a
      // purchase that succeeded, not a fact about money. Recording nothing is
      // the honest answer; the purchase is already the log's record.
      if (command.tier.length === 0) return [];

      return [
        new TopUpFailed({
          tier: command.tier,
          ...(command.price === undefined ? {} : { price: command.price }),
          provider: command.provider,
          reason: command.reason,
          at: now,
          commandId,
          // The count lives on the standing so a replay reproduces it, and a
          // failure is the only thing that moves it.
          attempt: topUpAttemptsOf(state) + 1,
        }),
      ];
    },
    RetryTopUp: (state, command) => {
      // A retry is only worth recording where it can still be acted on, and
      // every guard here is a way the rung went stale: the standing ended, the
      // line moved, the pool recovered, a cooldown took over, or the count says
      // a success or a newer failure already happened (ADR 0031).
      if (state._tag !== "Subscribed") return [];

      if (isTerminalStatus(state.status)) return [];

      const line = topUpOf(state);

      if (line === null) return [];

      if (topUpAttemptsOf(state) !== command.attempt) return [];

      if (state.topUpCooldownUntil !== undefined) return [];

      if (creditsOf(state) > line.threshold) return [];

      return [new TopUpRetryDue({ attempt: command.attempt })];
    },
    ReverseRefund: (state, command, { commandId }) => {
      // A non-positive reversal records nothing, like every other money command.
      if (command.amount <= 0) return [];

      const found = refundOfProviderId(state, command.refundId);

      if (found === null) return new RefundNotFound({ refundId: command.refundId });

      const { record } = found;
      const reversed = record.reversed ?? 0;
      const outstanding = record.amount - reversed;

      // The cap is the refund, not the currency: two refunds of one charge are
      // two facts, and reversing the second must not be refused because the
      // first is still standing.
      if (command.amount > outstanding) {
        return new RefundReversalExceedsRefunded({
          refundId: command.refundId,
          refunded: record.amount,
          reversed,
          requested: command.amount,
        });
      }

      return [
        new RefundReversed({
          refundId: command.refundId,
          amount: command.amount,
          currency: record.currency,
          refundedAfter: (refundedOf(state)[record.currency] ?? 0) - command.amount,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
          commandId,
        }),
      ];
    },
    TopUpCooldownElapsed: (state, _command, { now }) => {
      // The deadline is scheduled, so an account with no cooldown and a fire
      // before the deadline are both ordinary states, not operator mistakes.
      if (state._tag !== "Subscribed") return [];
      const until = state.topUpCooldownUntil;

      if (until === undefined) return [];

      if (DateTime.toEpochMillis(now) < DateTime.toEpochMillis(until)) return [];

      return [new TopUpCooldownCleared()];
    },
    ConsumeCredits: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      if (isTerminalStatus(state.status)) {
        return new StandingEnded({ account: id, status: state.status });
      }

      if (command.amount <= 0) return [];
      // Credits an open hold reserved are not spendable here: settle still has
      // to bill them, and a negative pool is a state no read can explain.
      const reserved = reservedCreditsOf(state);

      if (command.amount > state.credits - reserved) {
        return new CreditExceedsBalance({
          balance: state.credits,
          requested: command.amount,
          ...(reserved === 0 ? {} : { reserved }),
        });
      }

      return [
        new CreditsConsumed({
          amount: command.amount,
          balanceAfter: state.credits - command.amount,
        }),
      ];
    },
    CancelImmediately: (state, command, { id, commandId, now }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      if (isTerminalStatus(state.status)) {
        return new StandingEnded({ account: id, status: state.status });
      }

      const refund = command.refund;

      if (refund !== undefined && refund.amount > refundableOf(state, refund.currency)) {
        return new RefundExceedsCharged({
          currency: refund.currency,
          charged: refundableOf(state, refund.currency) + (refundedOf(state)[refund.currency] ?? 0),
          refunded: refundedOf(state)[refund.currency] ?? 0,
          requested: refund.amount,
        });
      }

      const released = openHoldsOf(state).map((hold) => releaseEvent(state, hold, "released"));
      const expiring = expiringCreditsOf(state);

      return [
        ...released,
        new SubscriptionCanceled({ canceledAt: now, statusAfter: "canceled" }),
        ...(expiring > 0
          ? [new CreditsExpired({ amount: expiring, balanceAfter: state.credits - expiring })]
          : []),
        ...(refund === undefined
          ? []
          : [
              new RefundRecorded({
                chargeId: refund.chargeId,
                refundId: refund.refundId,
                amount: refund.amount,
                currency: refund.currency,
                commandId,
                ...(refund.reason === undefined ? {} : { reason: refund.reason }),
                refundedAfter: (refundedOf(state)[refund.currency] ?? 0) + refund.amount,
              }),
            ]),
      ];
    },
    ScheduleTierChange: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      // A schedule only has a boundary to apply at if the standing still has
      // one. Scheduling on a terminal standing records a change no close will
      // ever read.
      if (isTerminalStatus(state.status)) {
        return new StandingEnded({ account: id, status: state.status });
      }

      // The payload is the catalog's terms and the close applies it from the log
      // alone, so it is checked here exactly as `ChangeTier` checks it. An
      // empty allowance is what a one-off pack carries: scheduling one would
      // move the standing onto a pack at the boundary and overwrite its pool
      // with the pack's credits.
      if (emptyAllowances(command.allowances)) {
        return new PlanNotInCatalog({ tier: command.tier });
      }

      const priceCurrency = command.price?.currency ?? unitPriceCurrencyOf(command.allowances);

      if (
        state.currency !== undefined &&
        priceCurrency !== undefined &&
        state.currency !== priceCurrency
      ) {
        return new CurrencyMismatch({ expected: state.currency, actual: priceCurrency });
      }

      return [
        new PlanChangeScheduled({
          tier: command.tier,
          allowances: command.allowances,
          ...(command.price === undefined ? {} : { price: command.price }),
          credits: command.credits,
          creditsExpire: command.creditsExpire,
          ...(command.topUp === undefined ? {} : { topUp: command.topUp }),
          rates: command.rates,
          ...(state.currency === undefined ? {} : { currency: state.currency }),
          interval: state.interval,
        }),
      ];
    },
    WithdrawTierChange: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      // Nothing pending is a refusal rather than a no-op, for the same reason
      // `Resume` refuses: the caller asked to withdraw something that is not
      // there, and the log should not record an intent that never existed.
      if (state.pendingTier === undefined) return new NoTierChangeScheduled();

      return [new TierChangeWithdrawn({ tier: state.pendingTier.tier })];
    },
    ScheduleCancellation: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      if (state.status === "canceled" || state.status === "expired" || state.cancelAtPeriodEnd) {
        return new AlreadyCanceled();
      }

      return [new CancellationScheduled({ cancelAtPeriodEndAfter: true })];
    },
    Resume: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      if (!state.cancelAtPeriodEnd) return new NotScheduled();

      return [new CancellationWithdrawn({ cancelAtPeriodEndAfter: false })];
    },
    ClosePeriod: (state, command, { id, now }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      if (!canClosePeriod(state, command.periodEnd, now)) {
        return new PeriodNotClosed({ periodEnd: command.periodEnd, now });
      }

      return closePeriodEvents(state, command.periodEnd);
    },
    PeriodEnded: (state, command, { now }) => {
      if (state._tag !== "Subscribed") return [];

      if (!canClosePeriod(state, command.periodEnd, now)) return [];

      return closePeriodEvents(state, command.periodEnd);
    },
    ResetAllowance: (state, command, { now }) => {
      if (state._tag !== "Subscribed") return [];
      const allowance = state.allowances[command.feature];

      if (allowance === undefined) return [];
      const boundary = state.resetAt?.[command.feature];

      if (boundary === undefined) return [];

      // A boundary a later tier change replaced is stale: the new chain owns
      // the feature, and this command must not close the new window early.
      if (DateTime.toEpochMillis(boundary) !== DateTime.toEpochMillis(command.at)) return [];

      if (DateTime.toEpochMillis(now) < DateTime.toEpochMillis(boundary)) return [];
      const reset = resetOfFeature(state, command.feature, allowance);

      const releases = Object.values(state.holds)
        .filter((hold) => hold.status === "open" && hold.feature === command.feature)
        .map((hold) => releaseEvent(state, hold, "reset"));

      return [
        ...releases,
        new PlanItemReset({
          feature: command.feature,
          remaining:
            reset.remaining === null
              ? null
              : reset.remaining + grantTotalOf(state, command.feature),
          carried: reset.carried,
          resetAt: nextResetAt(now, allowance),
        }),
      ];
    },
    GraceElapsed: (state, _command, { now }) => {
      if (state._tag !== "Subscribed" || state.status !== "grace") return [];

      if (
        state.graceUntil === undefined ||
        DateTime.toEpochMillis(now) < DateTime.toEpochMillis(state.graceUntil)
      ) {
        return [];
      }

      return [new SubscriptionExpired({ statusAfter: "expired" })];
    },
    Expire: (state) => {
      if (state._tag !== "Subscribed") return new NotInGrace({ status: "none" });

      if (state.status === "expired") return [];

      if (state.status !== "grace") return new NotInGrace({ status: state.status });

      return [new SubscriptionExpired({ statusAfter: "expired" })];
    },
    ExtendTrial: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });

      if (state.status !== "trialing") return new TrialNotActive();
      // `ExtendTrial` moves a deadline forward. A deadline that is not later
      // would shorten the trial and bring the period's close with it — the
      // opposite of the command's name — so it is refused rather than applied.
      const current = state.trialEndsAt ?? state.period.end;

      if (DateTime.toEpochMillis(command.trialEndsAt) <= DateTime.toEpochMillis(current)) {
        return new TrialDeadlineNotLater({ current, requested: command.trialEndsAt });
      }

      return [
        new TrialExtended({
          trialEndsAt: command.trialEndsAt,
          periodEnd: command.trialEndsAt,
        }),
      ];
    },
    AttachProviderRef: (_state, command) => [
      new ProviderRefAttached({ provider: command.provider, refs: command.refs }),
    ],
  },
  evolve: {
    TrialStarted: (state, event) => standingFrom(event, state, { trialUsed: true }),
    SubscriptionActivated: (state, event) =>
      standingFrom(event, state, {
        trialUsed: state._tag === "Subscribed" ? state.trialUsed : false,
      }),
    SubscriptionCanceled: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const { pendingTier: _pending, ...rest } = state;

      return {
        ...rest,
        status: event.statusAfter,
        cancelAtPeriodEnd: false,
        period: { ...state.period, end: event.canceledAt },
      };
    },
    PlanChanged: (state, event) => {
      if (state._tag !== "Subscribed") return state;

      const {
        price: _previousPrice,
        proration: _previousProration,
        prorationInvoice: _previousInvoice,
        prorationId: _previousProrationId,
        pendingTier: _cancelled,
        topUp: _previousTopUp,
        ...rest
      } = state;

      // Every prorated change takes the next id, including an identical change
      // in the same period: the seq is what makes a second charge a second
      // charge rather than a retry of the first.
      const prorationSeq =
        event.proration === undefined ? (state.prorationSeq ?? 0) : (state.prorationSeq ?? 0) + 1;

      return {
        ...rest,
        tier: event.tier,
        allowances: event.allowances,
        // New plan features come from the event. A feature the new plan drops
        // stays only if it still holds a grant — a lifetime grant is not the
        // plan's to remove (ADR 0037).
        remaining: {
          ...Object.fromEntries(
            Object.entries(state.remaining).filter(
              ([feature]) =>
                event.remaining[feature] === undefined && grantsOf(state, feature).length > 0,
            ),
          ),
          ...event.remaining,
        },
        credits: event.credits,
        prepaidCredits: event.prepaidCredits ?? 0,
        creditsExpire: event.creditsExpire,
        ...(event.topUp === undefined ? {} : { topUp: event.topUp }),
        rates: event.rates,
        ...((event.currency ?? state.currency) === undefined
          ? {}
          : { currency: (event.currency ?? state.currency)! }),
        interval: event.interval ?? state.interval,
        resetAt: event.resetAt ?? {},
        quantities: Object.fromEntries(
          Object.entries(event.allowances).flatMap(([feature, allowance]) => {
            if (!isQuantityGrant(allowance)) return [];
            const included = typeof allowance.included === "number" ? allowance.included : 0;

            return [
              [feature, quantityAfterTierChange(state.quantities?.[feature] ?? included, included)],
            ];
          }),
        ),
        ...(event.priceAfter === undefined ? {} : { price: event.priceAfter }),
        // A new tier change replaces what the old one owed; it does not add to
        // it, and an invoice for the old amount no longer applies.
        ...(event.proration === undefined ? {} : { proration: event.proration }),
        ...(event.proration === undefined ? {} : { prorationId: String(prorationSeq) }),
        ...(prorationSeq === 0 ? {} : { prorationSeq }),
      };
    },
    UsageRecorded: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            credits: event.creditsAfter,
            prepaidCredits: protectedAfterSpending(state, event.creditsAfter),
            usage: { ...state.usage, [event.feature]: event.usedAfter },
            ...(event.billedAfter === undefined
              ? {}
              : { billed: { ...state.billed, [event.feature]: event.billedAfter } }),
            remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
            ...(event.grantsUsed === undefined
              ? {}
              : { grants: grantsAfterSpend(state.grants, event.grantsUsed) }),
            dedupeKeys:
              event.dedupeKey === undefined
                ? state.dedupeKeys
                : { ...state.dedupeKeys, [event.dedupeKey]: true },
          }
        : {
            ...state,
            credits: event.creditsAfter,
            prepaidCredits: Math.max(0, Math.min(prepaidCreditsOf(state), event.creditsAfter)),
            usage: { ...state.usage, [event.feature]: event.usedAfter },
            remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
            ...(event.dedupeKey === undefined
              ? {}
              : { dedupeKeys: { ...state.dedupeKeys, [event.dedupeKey]: true } }),
          },
    UsageReserved: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            // The hold is the entity; `reserved` and `reservedCredits` are
            // folds of these, not counters a command writes.
            holds: {
              ...state.holds,
              [event.holdId]: {
                id: event.holdId,
                feature: event.feature,
                amount: event.amount,
                ...(event.dimension === undefined ? {} : { dimension: event.dimension }),
                rate: event.rate,
                cost: event.cost,
                at: event.at,
                expiresAt: event.expiresAt,
                status: "open" as const,
                ...(event.grantsUsed === undefined ? {} : { grantsUsed: event.grantsUsed }),
              },
            },
            remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
            ...(event.grantsUsed === undefined
              ? {}
              : { grants: grantsAfterSpend(state.grants, event.grantsUsed) }),
            dedupeKeys:
              event.dedupeKey === undefined
                ? state.dedupeKeys
                : { ...state.dedupeKeys, [event.dedupeKey]: true },
          }
        : state,
    UsageSettled: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const hold = holdOf(state, event.holdId);

      return {
        ...state,
        holds:
          hold === null
            ? state.holds
            : {
                ...state.holds,
                [hold.id]: closingHold(hold, nextHoldStatus(hold.status, "settle")),
              },
        remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
        grants: grantsAfterReturn(
          state.grants,
          hold?.grantsUsed,
          Object.values(event.grantsReturned ?? {}).reduce((sum, amount) => sum + amount, 0),
        ),
      };
    },
    UsageReleased: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const hold = holdOf(state, event.holdId);

      return {
        ...state,
        holds:
          hold === null
            ? state.holds
            : {
                ...state.holds,
                [hold.id]: closingHold(
                  hold,
                  nextHoldStatus(hold.status, event.reason === "expired" ? "expire" : "release"),
                ),
              },
        remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
        grants: grantsAfterReturn(
          state.grants,
          hold?.grantsUsed,
          Object.values(event.grantsReturned ?? {}).reduce((sum, amount) => sum + amount, 0),
        ),
      };
    },
    PaymentRecorded: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const { dunningStartedAt: _finishedRun, ...rest } = state;

      return {
        ...rest,
        status: event.statusAfter,
        graceUntil: undefined,
        dunningAttempts: 0,
        charged: chargedWith(state, event.currency, event.amount),
        ...(event.chargeId === undefined ? {} : { lastChargeId: event.chargeId }),
      };
    },
    PaymentFailed: (state, event, envelope) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            status: event.statusAfter,
            graceUntil: event.graceUntilAfter,
            dunningAttempts: event.attempt,
            dunningStartedAt: event.dunningStartedAt ?? state.dunningStartedAt ?? envelope.at,
          }
        : state,
    GraceEntered: (state, event) =>
      state._tag === "Subscribed"
        ? { ...state, status: event.statusAfter, graceUntil: event.graceUntil }
        : state,
    Recovered: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const { dunningStartedAt: _finishedRun, ...rest } = state;

      return {
        ...rest,
        status: event.statusAfter,
        graceUntil: undefined,
        dunningAttempts: 0,
      };
    },
    DunningRetryDue: (state) => state,
    CreditsGranted: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            credits: event.balanceAfter,
            prepaidCredits: protectedAfterSpending(state, event.balanceAfter),
          }
        : state,
    BalanceGranted: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            grants: grantedWith(state.grants, {
              id: event.grantId,
              feature: event.feature,
              granted: event.granted,
              remaining: event.granted,
              ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
              ...(event.planId === undefined ? {} : { planId: event.planId }),
            }),
            remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
          }
        : state,
    BalanceExpired: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            grants: grantsWithout(state.grants, event.grantId),
            remaining: { ...state.remaining, [event.feature]: event.balanceAfter },
          }
        : state,
    CreditsPurchased: (state, event) => {
      // A purchase is money charged, with or without a standing: the ceiling a
      // refund is measured against has to count a pack bought before a plan.
      const charged =
        event.price === undefined
          ? state.charged
          : chargedWith(state, event.price.currency, event.price.amount);

      if (state._tag !== "Subscribed") {
        return {
          ...state,
          credits: event.balanceAfter,
          prepaidCredits: event.prepaidAfter,
          ...(event.rates === undefined ? {} : { rates: event.rates }),
          ...(charged === undefined ? {} : { charged }),
        };
      }

      // A purchase is the refill that was owed, so the standing stops reporting
      // a failure it has since made good on, and the budget starts over: the
      // retries it spent bought this pack (ADR 0027, ADR 0031).
      const { topUpFailure: _madeGood, ...rest } = state;

      return {
        ...rest,
        topUpAttempts: 0,
        credits: event.balanceAfter,
        prepaidCredits: event.prepaidAfter,
        ...(charged === undefined ? {} : { charged }),
        ...(event.cooldownUntil === undefined ? {} : { topUpCooldownUntil: event.cooldownUntil }),
      };
    },
    RefundRecorded: (state, event) => ({
      ...state,
      refunded: refundedWith(state, event.currency, event.refundedAfter),
      refunds: {
        ...state.refunds,
        [event.commandId]: {
          refundId: event.refundId,
          amount: event.amount,
          currency: event.currency,
          refundedAfter: event.refundedAfter,
        },
      },
    }),
    TopUpFailed: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            topUpAttempts: event.attempt,
            topUpFailure: {
              tier: event.tier,
              ...(event.price === undefined ? {} : { price: event.price }),
              provider: event.provider,
              reason: event.reason,
              at: event.at,
            },
          }
        : state,
    RefundReversed: (state, event) => ({
      ...state,
      // The headroom comes back by exactly what returned, so a refund the
      // account is still owed is no longer refused by a refund that never
      // settled (ADR 0030).
      refunded: refundedWith(state, event.currency, event.refundedAfter),
      refunds: reversedWith(state.refunds, event.refundId, event.amount),
    }),
    // A rung that fired is a trigger, not a counter: the attempt it becomes is
    // recorded by the purchase or the failure that follows it.
    TopUpRetryDue: (state) => state,
    TopUpCooldownCleared: (state) => {
      if (state._tag !== "Subscribed" || state.topUpCooldownUntil === undefined) return state;
      const { topUpCooldownUntil: _cleared, ...rest } = state;

      return rest;
    },
    CreditsConsumed: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            credits: event.balanceAfter,
            prepaidCredits: protectedAfterSpending(state, event.balanceAfter),
          }
        : state,
    PlanChangeScheduled: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
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
          }
        : state,
    TierChangeWithdrawn: (state) => {
      if (state._tag !== "Subscribed") return state;
      // The schedule is data on the standing, so withdrawing it is dropping the
      // field. Everything else — the tier, the counters, the pool — is what the
      // account already had.
      const { pendingTier: _withdrawn, ...rest } = state;

      return rest;
    },
    CancellationScheduled: (state, event) =>
      state._tag === "Subscribed"
        ? { ...state, cancelAtPeriodEnd: event.cancelAtPeriodEndAfter }
        : state,
    CancellationWithdrawn: (state, event) =>
      state._tag === "Subscribed"
        ? { ...state, cancelAtPeriodEnd: event.cancelAtPeriodEndAfter }
        : state,
    PeriodClosed: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            status: event.statusAfter,
            period: {
              start: event.nextPeriodStart,
              end: event.nextPeriodEnd,
              anchorTz: state.period.anchorTz,
            },
            cancelAtPeriodEnd: event.cancelAtPeriodEndAfter,
            lastClosedPeriodStart: event.periodStart,
            // The period reset the pool, so a failure from the last one is not
            // this account's current problem and its budget is spent.
            topUpAttempts: 0,
            // An alert is once per standing period, so a close re-arms every
            // threshold (ADR 0038). An allowance's own reset window does not.
            alertsFired: {},
          }
        : state,
    PlanItemReset: (state, event) => {
      if (state._tag !== "Subscribed") return state;

      const resetAt = Object.fromEntries(
        Object.entries(state.resetAt ?? {}).filter(([feature]) => feature !== event.feature),
      );

      return {
        ...state,
        usage: { ...state.usage, [event.feature]: 0 },
        billed: { ...state.billed, [event.feature]: 0 },
        remaining: { ...state.remaining, [event.feature]: event.remaining },
        ...(event.resetAt === null
          ? {}
          : { resetAt: { ...resetAt, [event.feature]: event.resetAt } }),
        holds: Object.fromEntries(
          Object.entries(state.holds).filter(
            ([, hold]) => hold.feature !== event.feature || hold.status !== "open",
          ),
        ),
      };
    },
    QuantityChanged: (state, event) => {
      if (state._tag !== "Subscribed") return state;

      return {
        ...state,
        quantities: { ...state.quantities, [event.feature]: event.quantityAfter },
        remaining: {
          ...state.remaining,
          [event.feature]: event.quantityAfter - occupiedOf(state, event.feature),
        },
        ...(event.proration === undefined || event.prorationId === undefined
          ? {}
          : {
              quantityProrations: {
                ...state.quantityProrations,
                [event.prorationId]: { feature: event.feature, proration: event.proration },
              },
            }),
      };
    },
    UsageSet: (state, event) => {
      if (state._tag !== "Subscribed") return state;

      return {
        ...state,
        occupied: { ...state.occupied, [event.feature]: event.occupiedAfter },
        remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
      };
    },
    QuantityProrationInvoiced: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const entry = state.quantityProrations?.[event.prorationId];

      if (entry === undefined) return state;

      return {
        ...state,
        quantityProrations: {
          ...state.quantityProrations,
          [event.prorationId]: { ...entry, invoiceId: event.invoiceId },
        },
      };
    },
    UsageReset: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const kept = event.kept ?? {};

      // A kept feature keeps its usage, open holds and billing for the period;
      // everything else starts the next period at zero.
      return {
        ...state,
        usage: Object.fromEntries(
          Object.entries(state.usage).filter(([feature]) => kept[feature] === true),
        ),
        billed: Object.fromEntries(
          Object.entries(state.billed ?? {}).filter(([feature]) => kept[feature] === true),
        ),
        holds: Object.fromEntries(
          Object.entries(state.holds).filter(([, hold]) => kept[hold.feature] === true),
        ),
        remaining: event.remaining,
      };
    },
    // The invoice is the outcome: the log now says what was billed and on what.
    ProrationInvoiced: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            prorationInvoice: event.invoiceId,
            charged: chargedWith(state, event.currency, event.amount),
          }
        : state,
    CreditsExpired: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            credits: event.balanceAfter,
            prepaidCredits: protectedAfterSpending(state, event.balanceAfter),
          }
        : state,
    SubscriptionExpired: (state, event) =>
      state._tag === "Subscribed" ? { ...state, status: event.statusAfter } : state,
    TrialExtended: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            trialEndsAt: event.trialEndsAt,
            period: { ...state.period, end: event.periodEnd },
          }
        : state,
    ProviderRefAttached: (state, event) => ({
      ...state,
      refs: { ...state.refs, [event.provider]: event.refs },
    }),
    // The customer's controls are its own: a plan change, a close and a
    // cancellation leave them where they were. `SetBillingControls` replaces
    // the whole object, so the last write is the state (ADR 0038).
    BillingControlsSet: (state, event) => {
      if (event.billingControls === undefined) {
        const { billingControls: _cleared, ...rest } = state;

        return rest;
      }

      return { ...state, billingControls: event.billingControls };
    },
    // An alert moves no counter. It latches its threshold under the feature so
    // a redelivery and a second fact past the same threshold record once.
    UsageAlertFired: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            alertsFired: {
              ...state.alertsFired,
              [event.feature]: [...(state.alertsFired?.[event.feature] ?? []), event.at],
            },
          }
        : state,
  },
  reply: {
    SetQuantity: (_state, events) => {
      const changed = events.find((event) => event._tag === "QuantityChanged");

      return changed?._tag === "QuantityChanged"
        ? {
            quantityAfter: changed.quantityAfter,
            ...(changed.proration === undefined ? {} : { proration: changed.proration }),
          }
        : { quantityAfter: 0 };
    },
    SettleHold: (_state, events) => {
      const settled = events.find((event) => event._tag === "UsageSettled");

      return settled?._tag === "UsageSettled"
        ? { billed: settled.amount, released: settled.released, feature: settled.feature }
        : { billed: 0, released: 0, feature: "" };
    },
    ReleaseHold: (_state, events) => {
      const released = events.find((event) => event._tag === "UsageReleased");

      return released?._tag === "UsageReleased"
        ? { released: released.amount, feature: released.feature }
        : { released: 0, feature: "" };
    },
    SetUsage: (_state, events) => {
      const set = events.find((event) => event._tag === "UsageSet");

      return set?._tag === "UsageSet"
        ? { usage: set.occupiedAfter, remaining: set.remainingAfter }
        : { usage: 0, remaining: 0 };
    },
    GrantCredits: (state) => ({ balance: state._tag === "Subscribed" ? state.credits : 0 }),
    GrantBalance: (_state, events) => {
      const granted = events.find((event) => event._tag === "BalanceGranted");

      return granted?._tag === "BalanceGranted"
        ? { granted: granted.granted, balance: granted.remainingAfter }
        : { granted: 0, balance: 0 };
    },
    ConsumeCredits: (state) => ({ balance: state._tag === "Subscribed" ? state.credits : 0 }),
  },
  // The admin surface reads the aggregate whole. There is no tenant read here:
  // `Entitlements` is the boundary a customer sees. Guarded all the same, so a
  // route cannot reach raw state without an actor that may see it.
  read: {
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
  },
}) {}

/** The account's aggregate reference, for bindings and views. */
export const subscriptionRef = (account: string) => Subscription.ref(account);
