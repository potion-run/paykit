import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  isFlagGrant,
  type Allowances,
  type Included,
  type Overage,
  type Resets,
} from "../Allowance.ts";
import { Actor, mayActOn } from "../Auth/Actor.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { prorate } from "../Proration.ts";
import { AlreadyCanceled } from "./AlreadyCanceled.rejection.ts";
import { AttachProviderRef, ProviderRefAttached } from "./AttachProviderRef.command.ts";
import { ChangeTier, DowngradeBelowUsage, TierChanged } from "./ChangeTier.command.ts";
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
import { AlreadyInGrace, EnterGrace, GraceEntered } from "./EnterGrace.command.ts";
import { Expire, SubscriptionExpired } from "./Expire.command.ts";
import { ExtendTrial, TrialExtended, TrialNotActive } from "./ExtendTrial.command.ts";
import { GraceElapsed } from "./GraceElapsed.command.ts";
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
import { NotInGrace } from "./NotInGrace.rejection.ts";
import { NotScheduled } from "./NotScheduled.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { PeriodEnded } from "./PeriodEnded.command.ts";
import { ProrationMismatch } from "./ProrationMismatch.rejection.ts";
import { CreditsPurchased, PurchaseCredits } from "./PurchaseCredits.command.ts";
import { PaymentRecorded, RecordPayment } from "./RecordPayment.command.ts";
import { PaymentFailed, RecordPaymentFailure } from "./RecordPaymentFailure.command.ts";
import {
  NoProrationDue,
  ProrationInvoiced,
  RecordProrationInvoice,
} from "./RecordProrationInvoice.command.ts";
import { Recover, Recovered } from "./Recover.command.ts";
import { ReleaseHold, UsageReleased } from "./ReleaseHold.command.ts";
import { Resume, CancellationWithdrawn } from "./Resume.command.ts";
import { CancellationScheduled, ScheduleCancellation } from "./ScheduleCancellation.command.ts";
import { SettleHold, UsageSettled } from "./SettleHold.command.ts";
import { StartTrial, TrialStarted } from "./StartTrial.command.ts";
import { Subscribe, SubscriptionActivated } from "./Subscribe.command.ts";
import { AccountId } from "./Subscription.id.ts";
import {
  addInterval,
  allowsUsage,
  availableOf,
  billedOf,
  canEnterGrace,
  chargeOf,
  creditRateOf,
  creditsOf,
  expiringCreditsOf,
  holdOf,
  includedRemainingOf,
  initialSubscriptionState,
  periodFrom,
  prepaidCreditsOf,
  protectedAfterSpending,
  remainingAfterRelease,
  remainingAfterSpending,
  remainingOf,
  spendCeilingOf,
  closingHold,
  reservedCreditsOf,
  reservedOf,
  resetOf,
  standingOf,
  statusOf,
  SubscriptionState,
  usedOf,
  type HoldRecord,
  type SubscribedState,
  type SubscriptionStatus,
} from "./Subscription.state.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";
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

/** The currency a tier's postpaid prices are stated in, if it has any. */
const unitPriceCurrencyOf = (allowances: Allowances): string | undefined => {
  for (const allowance of Object.values(allowances)) {
    if (allowance.unitPrice !== undefined) return allowance.unitPrice.currency;
  }
  return undefined;
};

/** The part of an allowance `decide` reads when it derives a count. */
type CountableAllowance = {
  readonly included: Included;
  readonly overage: Overage;
  readonly resets: Resets;
};

const startingRemaining = (
  allowances: Readonly<Record<string, CountableAllowance>>,
): Record<string, number | null> =>
  Object.fromEntries(
    Object.entries(allowances).map(([feature, allowance]) => [
      feature,
      includedRemainingOf(allowance),
    ]),
  );

const remainingAfterChange = (
  state: SubscribedState,
  allowances: Readonly<Record<string, CountableAllowance>>,
): Record<string, number | null> =>
  Object.fromEntries(
    Object.entries(allowances).map(([feature, allowance]) => {
      // Usage and open reservations both still owe the old period's units. An
      // allowance with no count — unlimited, or a flag's grant — has none to
      // owe them against.
      const spendable = includedRemainingOf(allowance);
      return [
        feature,
        spendable === null ? null : spendable - usedOf(state, feature) - reservedOf(state, feature),
      ];
    }),
  );

const emptyAllowances = (allowances: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(allowances).length === 0;

/** Two prorations are the same money, or both absent. */
const sameProration = (
  left: { readonly credit: number; readonly charge: number; readonly due: number } | null,
  right: { readonly credit: number; readonly charge: number; readonly due: number } | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.credit === right.credit && left.charge === right.charge && left.due === right.due;

const subscribed = (state: SubscriptionState, account: string): SubscribedState | NotSubscribed =>
  state._tag === "Subscribed" ? state : new NotSubscribed({ account });

/**
 * The one-off portion an activation or change carries over, omitted when there
 * is none so an event for an ordinary plan does not grow a zero field.
 */
const carriedPrepaid = (state: SubscriptionState, credits: number) => {
  const prepaid = Math.min(prepaidCreditsOf(state), credits);
  return prepaid === 0 ? {} : { prepaidCredits: prepaid };
};

/**
 * The event that returns an open hold's units (or credits) to a standing. A
 * release and a sweep record the same event, because an expired hold is a
 * cleanup and not a charge.
 */
const releaseEvent = (state: SubscribedState, hold: HoldRecord): UsageReleased => {
  // A credit-priced hold returns what it took — `cost` credits, not `amount`
  // units — so the log's remaining stays in one unit of account.
  const returns = state.rates[hold.feature] === undefined ? hold.amount : hold.cost;
  return new UsageReleased({
    holdId: hold.id,
    feature: hold.feature,
    amount: hold.amount,
    cost: hold.cost,
    remainingAfter: remainingAfterRelease(availableOf(state, hold.feature), returns),
  });
};

const closePeriodEvents = (state: SubscribedState, periodEnd: DateTime.Utc) => {
  const nextPeriodStart = periodEnd;
  const nextPeriodEnd = addInterval(nextPeriodStart, state.interval);
  const statusAfter: SubscriptionStatus = state.cancelAtPeriodEnd
    ? "canceled"
    : state.status === "trialing"
      ? "active"
      : state.status;
  // One reset per allowance, so `remaining` and `carried` cannot disagree about
  // what the closing period left behind.
  const resets = Object.entries(state.allowances).map(
    ([feature, allowance]) => [feature, resetOf(state, feature, allowance)] as const,
  );
  // A `resets: "never"` feature keeps its usage, holds and remainder, so the
  // reset does not touch it.
  const kept = Object.fromEntries(
    resets.filter(([, reset]) => reset.kept).map(([feature]) => [feature, true]),
  );
  // A one-off pack bought from a period pool is never expired; only the plan's
  // own credits go back.
  const expiring = expiringCreditsOf(state);
  return [
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
    // and a one-off pack bought from a period pool is never expired.
    ...(state.creditsExpire === "period"
      ? [
          new CreditsExpired({
            amount: expiring,
            balanceAfter: state.credits - expiring,
          }),
        ]
      : []),
  ];
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
    GrantCredits,
    PurchaseCredits,
    ConsumeCredits,
    ScheduleCancellation,
    Resume,
    ClosePeriod,
    Expire,
    ExtendTrial,
    AttachProviderRef,
    PeriodEnded,
    GraceElapsed,
  ],
  decide: {
    StartTrial: (state, command, { id, now }) => {
      if (state._tag === "Subscribed" && state.trialUsed) {
        return new TrialAlreadyUsed({ account: id });
      }
      if (emptyAllowances(command.allowances)) {
        return new TierNotInCatalog({ tier: command.tier });
      }
      const currentCurrency = state._tag === "Subscribed" ? state.currency : undefined;
      const currency = command.price?.currency ?? unitPriceCurrencyOf(command.allowances);
      if (currentCurrency !== undefined && currency !== undefined && currentCurrency !== currency) {
        return new CurrencyMismatch({ expected: currentCurrency, actual: currency });
      }
      return [
        new TrialStarted({
          tier: command.tier,
          allowances: command.allowances,
          remaining: startingRemaining(command.allowances),
          periodStart: now,
          periodEnd: command.trialEndsAt,
          anchorTz: command.anchorTz ?? "UTC",
          trialEndsAt: command.trialEndsAt,
          ...(command.price === undefined ? {} : { price: command.price }),
          ...((currency ?? currentCurrency) === undefined
            ? {}
            : { currency: (currency ?? currentCurrency)! }),
          // A pack the account already bought survives a new activation; the
          // plan's own grant is the only part that starts fresh.
          credits: command.credits + prepaidCreditsOf(state),
          ...carriedPrepaid(state, command.credits + prepaidCreditsOf(state)),
          creditsExpire: command.creditsExpire,
          rates: command.rates,
          statusAfter: "trialing",
        }),
      ];
    },
    Subscribe: (state, command, { now }) => {
      if (emptyAllowances(command.allowances)) {
        return new TierNotInCatalog({ tier: command.tier });
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
      return [
        new SubscriptionActivated({
          tier: command.tier,
          allowances: command.allowances,
          remaining: startingRemaining(command.allowances),
          periodStart: period.start,
          periodEnd: period.end,
          anchorTz: period.anchorTz,
          interval,
          ...((priceCurrency ?? currentCurrency) === undefined
            ? {}
            : { currency: (priceCurrency ?? currentCurrency)! }),
          ...(command.price === undefined ? {} : { price: command.price }),
          // A pack the account already bought survives a new activation; the
          // plan's own grant is the only part that starts fresh.
          credits: command.credits + prepaidCreditsOf(state),
          ...carriedPrepaid(state, command.credits + prepaidCreditsOf(state)),
          creditsExpire: command.creditsExpire,
          rates: command.rates,
          statusAfter: "active",
        }),
      ];
    },
    ChangeTier: (state, command, { id, now }) => {
      if (emptyAllowances(command.allowances)) {
        return new TierNotInCatalog({ tier: command.tier });
      }
      const current = subscribed(state, id);
      if (Schema.is(NotSubscribed)(current)) return current;
      for (const [feature, allowance] of Object.entries(command.allowances)) {
        const used = usedOf(current, feature);
        const reserved = reservedOf(current, feature);
        // An unlimited allowance is never below any usage, so only a counted
        // one can be a downgrade below what the account already owes. Open
        // holds are owed too: moving below them would leave a blocking
        // allowance oversubscribed the moment the change commits.
        if (allowance.included !== "unlimited" && used + reserved > allowance.included) {
          return new DowngradeBelowUsage({
            feature,
            included: allowance.included,
            used,
            ...(reserved === 0 ? {} : { reserved }),
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
        new TierChanged({
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
          ...carriedPrepaid(current, current.credits),
          creditsExpire: command.creditsExpire,
          rates: command.rates,
          ...(current.price === undefined ? {} : { priceBefore: current.price }),
          ...(command.price === undefined ? {} : { priceAfter: command.price }),
          ...(command.proration === undefined ? {} : { proration: command.proration }),
        }),
      ];
    },
    TrackUsage: (state, command) => {
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
        const cost = command.amount * creditRateOf(rates, command.dimension);
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
      const standing = standingOf(state.status);
      if (!allowsUsage(state.status)) {
        return new StandingBlocksUsage({ standing, status: state.status });
      }
      const allowance = state.allowances[command.feature];
      // A flag is granted, not metered: there is no counter to record usage
      // against, so a Track on one is refused however small the amount is.
      if (allowance !== undefined && isFlagGrant(allowance)) {
        return new FeatureNotMetered({ feature: command.feature });
      }
      if (command.amount <= 0) return [];
      if (command.dedupeKey !== undefined && state.dedupeKeys[command.dedupeKey] === true) {
        return [];
      }
      // A credit-priced feature spends the account's pool: the event carries
      // the cost and the balance after it, so the pool is a fold of the log.
      const rates = state.rates[command.feature];
      if (rates !== undefined) {
        const cost = command.amount * creditRateOf(rates, command.dimension);
        // Open holds have already taken their credits out of what may be
        // spent. Comparing against the whole pool would let one request spend
        // the credits another hold is waiting to settle.
        const spendable = availableOf(state, command.feature) ?? 0;
        if (cost > spendable) {
          const reserved = reservedCreditsOf(state);
          return new CreditExceeded({
            feature: command.feature,
            cost,
            // The pool is still the evidence an operator reads; `spendable` is
            // what the comparison used.
            balance: state.credits,
            ...(reserved === 0 ? {} : { reserved }),
          });
        }
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
      if (allowance === undefined) {
        return new AllowanceExceeded({
          feature: command.feature,
          included: 0,
          used,
          requested: command.amount,
          remaining: 0,
        });
      }
      // A cap is a ceiling in the feature's own units. What is held counts, so
      // a hold cannot promise a bill the allowance may not run.
      const ceiling = spendCeilingOf(allowance);
      if (ceiling !== null) {
        const reserved = reservedOf(state, command.feature);
        if (used + reserved + command.amount > ceiling) {
          return new SpendCapExceeded({
            feature: command.feature,
            cap: allowance.cap!,
            used,
            reserved,
            requested: command.amount,
          });
        }
      }
      // A postpaid feature prices only the part past `included`, and a money
      // cap refuses in the same transaction as the usage.
      const reservedUnits = reservedOf(state, command.feature);
      // The event bills the units it records now, at their own position after
      // `used`; the open holds are a separate promise. A money cap judges both:
      // the promised total from `used` over `reserved + amount`, so the
      // included room is counted once, not once per bucket.
      const charge = chargeOf(allowance.unitPrice, allowance.included, used, command.amount);
      const reservedCharge = chargeOf(allowance.unitPrice, allowance.included, used, reservedUnits);
      const promisedCharge = chargeOf(
        allowance.unitPrice,
        allowance.included,
        used + reservedUnits,
        command.amount,
      );
      const billed = billedOf(state, command.feature);
      if (
        allowance.moneyCap !== undefined &&
        billed + reservedCharge + promisedCharge > allowance.moneyCap
      ) {
        return new MoneyCapExceeded({
          feature: command.feature,
          cap: allowance.moneyCap,
          billed,
          ...(reservedCharge === 0 ? {} : { reserved: reservedCharge }),
          charge: promisedCharge,
        });
      }
      // An allowance that never runs out never blocks: `used` keeps counting
      // and `remaining` stays absent.
      if (
        allowance.included !== "unlimited" &&
        allowance.overage === "block" &&
        remaining !== null &&
        command.amount > remaining
      ) {
        return new AllowanceExceeded({
          feature: command.feature,
          included: allowance.included,
          used,
          requested: command.amount,
          remaining,
        });
      }
      return [
        new UsageRecorded({
          feature: command.feature,
          amount: command.amount,
          // A feature counted in its own units spends no credits.
          cost: 0,
          creditsAfter: state.credits,
          usedAfter: used + command.amount,
          remainingAfter: remainingAfterSpending(remaining, command.amount),
          ...(allowance.unitPrice === undefined ? {} : { charge, billedAfter: billed + charge }),
          ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
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
          statusAfter: "active",
        }),
      ];
    },
    RecordPaymentFailure: (state, command) => {
      if (state._tag !== "Subscribed") return [];
      if (state.status === "expired" || state.status === "canceled") return [];
      const graceUntil =
        state.graceUntil !== undefined &&
        DateTime.toEpochMillis(state.graceUntil) > DateTime.toEpochMillis(command.graceUntil)
          ? state.graceUntil
          : command.graceUntil;
      return [
        new PaymentFailed({
          reason: command.reason,
          graceUntilAfter: graceUntil,
          statusAfter: "grace",
          attempt: state.dunningAttempts + 1,
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
      // A flag has no counter and no pool: it is granted or it is not.
      const allowance = state.allowances[command.feature];
      if (allowance !== undefined && isFlagGrant(allowance)) {
        return new FeatureNotMetered({ feature: command.feature });
      }
      const rates = state.rates[command.feature];
      // A hold with the id this standing already has is a replay: the retry
      // holds once, and the caller gets the same id back.
      if (holdOf(state, command.holdId) !== null) return [];
      if (command.amount <= 0) return [];
      if (command.dedupeKey !== undefined && state.dedupeKeys[command.dedupeKey] === true) {
        return [];
      }
      // A feature the tier neither counts nor prices has no capacity to
      // reserve. Without this check it would hold its units at rate 0 and
      // settle usage the catalog never granted.
      if (allowance === undefined && rates === undefined) {
        return new HoldExceeded({
          feature: command.feature,
          requested: command.amount,
          held: 0,
          remaining: 0,
        });
      }
      // A hold is a promise to bill, so it counts against the ceilings in the
      // same transaction that would have held the units.
      const used = usedOf(state, command.feature);
      const reserved = reservedOf(state, command.feature);
      const ceiling = allowance === undefined ? null : spendCeilingOf(allowance);
      if (allowance !== undefined && ceiling !== null) {
        if (used + reserved + command.amount > ceiling) {
          return new SpendCapExceeded({
            feature: command.feature,
            cap: allowance.cap!,
            used,
            reserved,
            requested: command.amount,
          });
        }
      }
      const reservedCharge = chargeOf(
        allowance?.unitPrice,
        allowance?.included ?? null,
        used,
        reserved,
      );
      // The hold is promised after the holds already open, so the cap judges
      // the same incremental charge a settle will eventually bill.
      const charge = chargeOf(
        allowance?.unitPrice,
        allowance?.included ?? null,
        used + reserved,
        command.amount,
      );
      const billedMoney = billedOf(state, command.feature);
      if (
        allowance?.moneyCap !== undefined &&
        billedMoney + reservedCharge + charge > allowance.moneyCap
      ) {
        return new MoneyCapExceeded({
          feature: command.feature,
          cap: allowance.moneyCap,
          billed: billedMoney,
          ...(reservedCharge === 0 ? {} : { reserved: reservedCharge }),
          charge,
        });
      }
      // The rate is captured here, so the bill at settle is the price the work
      // was priced at, not whatever the catalog says when it finishes.
      const rate = rates === undefined ? 0 : creditRateOf(rates, command.dimension);
      const cost = command.amount * rate;
      const remaining = availableOf(state, command.feature);
      const spendable = remaining ?? 0;
      // A credit-priced feature holds credits from the pool, so the pool must
      // cover it. A counted one holds its own units: a billed allowance may
      // sit at a negative `remaining` and still hold into its cap, so only the
      // block and ceiling checks below decide that case.
      if (rates !== undefined && cost > spendable) {
        return new HoldExceeded({
          feature: command.feature,
          requested: cost,
          held: 0,
          remaining: spendable,
        });
      }
      // A blocking allowance has no room past `remaining`, so the hold stops
      // there. A billed one holds into what it may bill — the cap is its
      // ceiling, and it is judged above.
      if (rates === undefined && allowance?.overage === "block" && command.amount > spendable) {
        return new HoldExceeded({
          feature: command.feature,
          requested: command.amount,
          held: 0,
          remaining: spendable,
        });
      }
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
      if (hold.status === "released") {
        return new HoldSettled({ holdId: hold.id, feature: hold.feature });
      }
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
      const charge = chargeOf(allowance?.unitPrice, allowance?.included ?? null, used, billed);
      const billedMoney = billedOf(state, hold.feature);
      // The other open holds are promises to bill too; this one is being
      // billed now, so it is in `charge`, not in `reservedCharge`.
      const otherReserved = Math.max(0, reservedOf(state, hold.feature) - hold.amount);
      const reservedCharge = chargeOf(
        allowance?.unitPrice,
        allowance?.included ?? null,
        used + billed,
        otherReserved,
      );
      if (
        allowance?.moneyCap !== undefined &&
        billedMoney + charge + reservedCharge > allowance.moneyCap
      ) {
        return new MoneyCapExceeded({
          feature: hold.feature,
          cap: allowance.moneyCap,
          billed: billedMoney,
          ...(reservedCharge === 0 ? {} : { reserved: reservedCharge }),
          charge,
        });
      }
      // The hold took its units (or credits) out when it was placed; what it
      // did not bill comes back here. An unlimited allowance stays `null`.
      const available = availableOf(state, hold.feature);
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
          ...(allowance?.unitPrice === undefined
            ? {}
            : { charge, billedAfter: billedMoney + charge }),
          ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
        }),
        new UsageSettled({
          holdId: hold.id,
          feature: hold.feature,
          amount: billed,
          released,
          cost: hold.cost,
          remainingAfter: remaining,
        }),
      ];
    },
    ReleaseHold: (state, command) => {
      if (state._tag === "Unsubscribed") return new HoldUnknown({ holdId: command.holdId });
      const hold = holdOf(state, command.holdId);
      if (hold === null) return new HoldUnknown({ holdId: command.holdId });
      // A released hold is a replay; a settled one was billed, so the units
      // are not there to give back.
      if (hold.status === "released") return [];
      if (hold.status === "settled") {
        return new HoldSettled({ holdId: hold.id, feature: hold.feature });
      }
      // A late release is a cleanup, not a charge: expiry does not refuse it.
      return [releaseEvent(state, hold)];
    },
    HoldElapsed: (state, command, { now }) => {
      // The deadline is scheduled, so none of these is an operator's mistake:
      // an unknown id, a hold that already closed, and a fire before the
      // deadline all record nothing.
      if (state._tag === "Unsubscribed") return [];
      const hold = holdOf(state, command.holdId);
      if (hold === null || hold.status !== "open") return [];
      if (DateTime.toEpochMillis(now) < DateTime.toEpochMillis(hold.expiresAt)) return [];
      // Releasing here is the same cleanup `ReleaseHold` performs, so a late
      // settle still refuses and a late release is a replay.
      return [releaseEvent(state, hold)];
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
          balanceAfter: creditsOf(state) + command.amount,
          prepaidAfter: prepaidCreditsOf(state) + command.amount,
        }),
      ];
    },
    ConsumeCredits: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });
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
    TrialStarted: (state, event) => ({
      _tag: "Subscribed" as const,
      tier: event.tier,
      status: event.statusAfter,
      period: {
        start: event.periodStart,
        end: event.periodEnd,
        anchorTz: event.anchorTz,
      },
      interval: event.price?.interval ?? ("month" as const),
      trialEndsAt: event.trialEndsAt,
      cancelAtPeriodEnd: false,
      credits: event.credits,
      prepaidCredits: event.prepaidCredits ?? 0,
      creditsExpire: event.creditsExpire,
      rates: event.rates,
      ...(event.currency === undefined
        ? state._tag === "Subscribed" && state.currency !== undefined
          ? { currency: state.currency }
          : {}
        : { currency: event.currency }),
      ...(event.price === undefined ? {} : { price: event.price }),
      usage: {},
      remaining: event.remaining,
      holds: {},
      allowances: event.allowances,
      refs: state.refs,
      trialUsed: true,
      dedupeKeys: {},
      dunningAttempts: 0,
    }),
    SubscriptionActivated: (state, event) => ({
      _tag: "Subscribed" as const,
      tier: event.tier,
      status: event.statusAfter,
      period: {
        start: event.periodStart,
        end: event.periodEnd,
        anchorTz: event.anchorTz,
      },
      interval: event.interval,
      cancelAtPeriodEnd: false,
      credits: event.credits,
      prepaidCredits: event.prepaidCredits ?? 0,
      creditsExpire: event.creditsExpire,
      rates: event.rates,
      ...(event.currency === undefined ? {} : { currency: event.currency }),
      ...(event.price === undefined ? {} : { price: event.price }),
      usage: {},
      remaining: event.remaining,
      holds: {},
      allowances: event.allowances,
      refs: state.refs,
      trialUsed: state._tag === "Subscribed" ? state.trialUsed : false,
      dedupeKeys: {},
      dunningAttempts: 0,
    }),
    TierChanged: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const {
        price: _previousPrice,
        proration: _previousProration,
        prorationInvoice: _previousInvoice,
        ...rest
      } = state;
      return {
        ...rest,
        tier: event.tier,
        allowances: event.allowances,
        remaining: event.remaining,
        credits: event.credits,
        prepaidCredits: event.prepaidCredits ?? 0,
        creditsExpire: event.creditsExpire,
        rates: event.rates,
        ...((event.currency ?? state.currency) === undefined
          ? {}
          : { currency: (event.currency ?? state.currency)! }),
        interval: event.interval ?? state.interval,
        ...(event.priceAfter === undefined ? {} : { price: event.priceAfter }),
        // A new tier change replaces what the old one owed; it does not add to
        // it, and an invoice for the old amount no longer applies.
        ...(event.proration === undefined ? {} : { proration: event.proration }),
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
              },
            },
            remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
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
          hold === null ? state.holds : { ...state.holds, [hold.id]: closingHold(hold, "settled") },
        remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
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
            : { ...state.holds, [hold.id]: closingHold(hold, "released") },
        remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
      };
    },
    PaymentRecorded: (state, event) =>
      state._tag === "Subscribed"
        ? { ...state, status: event.statusAfter, graceUntil: undefined, dunningAttempts: 0 }
        : state,
    PaymentFailed: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            status: event.statusAfter,
            graceUntil: event.graceUntilAfter,
            dunningAttempts: event.attempt,
          }
        : state,
    GraceEntered: (state, event) =>
      state._tag === "Subscribed"
        ? { ...state, status: event.statusAfter, graceUntil: event.graceUntil }
        : state,
    Recovered: (state, event) =>
      state._tag === "Subscribed"
        ? { ...state, status: event.statusAfter, graceUntil: undefined, dunningAttempts: 0 }
        : state,
    CreditsGranted: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            credits: event.balanceAfter,
            prepaidCredits: protectedAfterSpending(state, event.balanceAfter),
          }
        : state,
    CreditsPurchased: (state, event) =>
      state._tag === "Subscribed"
        ? { ...state, credits: event.balanceAfter, prepaidCredits: event.prepaidAfter }
        : {
            ...state,
            credits: event.balanceAfter,
            prepaidCredits: event.prepaidAfter,
            ...(event.rates === undefined ? {} : { rates: event.rates }),
          },
    CreditsConsumed: (state, event) =>
      state._tag === "Subscribed"
        ? {
            ...state,
            credits: event.balanceAfter,
            prepaidCredits: protectedAfterSpending(state, event.balanceAfter),
          }
        : state,
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
          }
        : state,
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
      state._tag === "Subscribed" ? { ...state, prorationInvoice: event.invoiceId } : state,
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
  },
  reply: {
    GrantCredits: (state) => ({ balance: state._tag === "Subscribed" ? state.credits : 0 }),
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
        return yield* new Forbidden({ account: key.id, actor: actor.id, kind: actor.kind });
      }
    }),
  },
}) {}

/** The account's aggregate reference, for bindings and views. */
export const subscriptionRef = (account: string) => Subscription.ref(account);
