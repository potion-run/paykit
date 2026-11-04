import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isFlagGrant, type Included, type Overage, type Resets } from "../Allowance.ts";
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
import { NotInGrace } from "./NotInGrace.rejection.ts";
import { NotScheduled } from "./NotScheduled.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { PeriodEnded } from "./PeriodEnded.command.ts";
import { ProrationMismatch } from "./ProrationMismatch.rejection.ts";
import { PaymentRecorded, RecordPayment } from "./RecordPayment.command.ts";
import { PaymentFailed, RecordPaymentFailure } from "./RecordPaymentFailure.command.ts";
import {
  NoProrationDue,
  ProrationInvoiced,
  RecordProrationInvoice,
} from "./RecordProrationInvoice.command.ts";
import { Recover, Recovered } from "./Recover.command.ts";
import { ReleaseUsage, UsageReleased } from "./ReleaseUsage.command.ts";
import {
  CreditHoldUnsupported,
  ReservationExceeded,
  ReservationExists,
  ReserveUsage,
  UsageReserved,
} from "./ReserveUsage.command.ts";
import { Resume, CancellationWithdrawn } from "./Resume.command.ts";
import { CancellationScheduled, ScheduleCancellation } from "./ScheduleCancellation.command.ts";
import { NoReservation, SettleUsage, UsageSettled } from "./SettleUsage.command.ts";
import { StartTrial, TrialStarted } from "./StartTrial.command.ts";
import { Subscribe, SubscriptionActivated } from "./Subscribe.command.ts";
import { AccountId } from "./Subscription.id.ts";
import {
  addInterval,
  allowsUsage,
  canEnterGrace,
  creditRateOf,
  includedRemainingOf,
  initialSubscriptionState,
  periodFrom,
  remainingAfterRelease,
  remainingAfterSpending,
  remainingOf,
  reservationSequenceOf,
  reservationsOf,
  reservedOf,
  resetOf,
  standingOf,
  statusOf,
  SubscriptionState,
  usedOf,
  type SubscribedState,
  type SubscriptionStatus,
} from "./Subscription.state.ts";
import { TierNotInCatalog } from "./TierNotInCatalog.rejection.ts";
import {
  AllowanceExceeded,
  CreditExceeded,
  FeatureNotMetered,
  StandingBlocksUsage,
  TrackUsage,
  UsageRecorded,
} from "./TrackUsage.command.ts";
import { TrialAlreadyUsed } from "./TrialAlreadyUsed.rejection.ts";

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

/** One hold the amount being settled or released, or the unnamed remainder. */
type Allocation = { readonly reservationId: string | undefined; readonly amount: number };

/** The open reservations for one feature, in the order they were taken. */
const openReservationsOf = (state: SubscribedState, feature: string) =>
  Object.values(reservationsOf(state)).filter(
    (reservation) => reservation.feature === feature && reservation.remaining > 0,
  );

/**
 * Split an amount across open holds. A named hold must cover the whole amount;
 * an unnamed one consumes holds first-in-first-out and falls back to the
 * per-feature total only for state written before holds had ids.
 */
const allocationsOf = (
  state: SubscribedState,
  feature: string,
  amount: number,
  reservationId: string | undefined,
): { readonly allocations: ReadonlyArray<Allocation> } | { readonly rejection: NoReservation } => {
  const reserved = reservedOf(state, feature);
  const open = openReservationsOf(state, feature);
  if (reservationId !== undefined) {
    const reservation = open.find((candidate) => candidate.id === reservationId);
    if (reservation === undefined) {
      return {
        rejection: new NoReservation({ feature, requested: amount, reserved, reservationId }),
      };
    }
    if (amount > reservation.remaining) {
      return {
        rejection: new NoReservation({
          feature,
          requested: amount,
          reserved: reservation.remaining,
          reservationId,
        }),
      };
    }
    return { allocations: [{ reservationId, amount }] };
  }
  if (amount > reserved) {
    return { rejection: new NoReservation({ feature, requested: amount, reserved }) };
  }
  const allocations: Array<Allocation> = [];
  let left = amount;
  for (const reservation of open) {
    if (left === 0) break;
    const take = Math.min(reservation.remaining, left);
    allocations.push({ reservationId: reservation.id, amount: take });
    left -= take;
  }
  // A hold recorded before this state carried ids: the total still covers it.
  if (left > 0) allocations.push({ reservationId: undefined, amount: left });
  return { allocations };
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
  const kept = Object.fromEntries(
    resets.filter(([, reset]) => reset.kept).map(([feature]) => [feature, true]),
  );
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
    // Expiry is a property of the grant: a "never" pool survives the boundary.
    ...(state.creditsExpire === "period"
      ? [new CreditsExpired({ amount: state.credits, balanceAfter: 0 })]
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
    ReserveUsage,
    SettleUsage,
    ReleaseUsage,
    RecordProrationInvoice,
    GrantCredits,
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
          credits: command.credits,
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
      const priceCurrency = command.price?.currency;
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
          credits: command.credits,
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
        // An unlimited allowance is never below any usage, so only a counted
        // one can be a downgrade below what the account already spent.
        if (allowance.included !== "unlimited" && used > allowance.included) {
          return new DowngradeBelowUsage({ feature, included: allowance.included, used });
        }
      }
      const priceCurrency = command.price?.currency;
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
          // move to the new tier's.
          credits: current.credits,
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
        return new StandingBlocksUsage({ standing: "blocked", status: "none" });
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
        if (cost > state.credits) {
          return new CreditExceeded({
            feature: command.feature,
            cost,
            balance: state.credits,
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
    ReserveUsage: (state, command) => {
      if (state._tag === "Unsubscribed") {
        return new StandingBlocksUsage({ standing: "blocked", status: "none" });
      }
      if (!allowsUsage(state.status)) {
        return new StandingBlocksUsage({
          standing: standingOf(state.status),
          status: state.status,
        });
      }
      const allowance = state.allowances[command.feature];
      // A flag has no counter, so there is nothing to hold against it.
      if (allowance !== undefined && isFlagGrant(allowance)) {
        return new FeatureNotMetered({ feature: command.feature });
      }
      // Credits are never held: this slice spends them and nothing more.
      if (state.rates[command.feature] !== undefined) {
        return new CreditHoldUnsupported({ feature: command.feature });
      }
      if (command.amount <= 0) return [];
      if (command.dedupeKey !== undefined && state.dedupeKeys[command.dedupeKey] === true) {
        return [];
      }
      const used = usedOf(state, command.feature);
      const reserved = reservedOf(state, command.feature);
      const remaining = remainingOf(state, command.feature);
      if (allowance === undefined) {
        return new ReservationExceeded({
          feature: command.feature,
          included: 0,
          used,
          reserved,
          requested: command.amount,
          remaining: 0,
        });
      }
      // A hold is only refused when there is a count it would exceed. An
      // unlimited allowance holds whatever is asked.
      if (allowance.included !== "unlimited" && remaining !== null && command.amount > remaining) {
        return new ReservationExceeded({
          feature: command.feature,
          included: allowance.included,
          used,
          reserved,
          requested: command.amount,
          remaining,
        });
      }
      const open = reservationsOf(state);
      let sequence = reservationSequenceOf(state) + 1;
      let reservationId = command.reservationId ?? command.dedupeKey ?? `hold:${sequence}`;
      if (command.reservationId !== undefined && open[reservationId] !== undefined) {
        return new ReservationExists({ reservationId });
      }
      // A generated id never overwrites an id a caller chose earlier.
      while (command.reservationId === undefined && open[reservationId] !== undefined) {
        sequence += 1;
        reservationId = `hold:${sequence}`;
      }
      return [
        new UsageReserved({
          feature: command.feature,
          amount: command.amount,
          reservedAfter: reserved + command.amount,
          remainingAfter: remainingAfterSpending(remaining, command.amount),
          reservationId,
          sequence,
          ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
        }),
      ];
    },
    SettleUsage: (state, command) => {
      if (state._tag !== "Subscribed" || !allowsUsage(state.status)) {
        return new StandingBlocksUsage({
          standing: standingOf(statusOf(state)),
          status: statusOf(state),
        });
      }
      const allowance = state.allowances[command.feature];
      // A flag is never held, so it is never settled: refuse the feature, not
      // the missing reservation.
      if (allowance !== undefined && isFlagGrant(allowance)) {
        return new FeatureNotMetered({ feature: command.feature });
      }
      if (state.rates[command.feature] !== undefined) {
        return new CreditHoldUnsupported({ feature: command.feature });
      }
      if (command.amount <= 0) return [];
      if (command.dedupeKey !== undefined && state.dedupeKeys[command.dedupeKey] === true) {
        return [];
      }
      const reserved = reservedOf(state, command.feature);
      const allocation = allocationsOf(
        state,
        command.feature,
        command.amount,
        command.reservationId,
      );
      if ("rejection" in allocation) return allocation.rejection;
      const used = usedOf(state, command.feature);
      const remaining = remainingOf(state, command.feature);
      let reservedAfter = reserved;
      return [
        new UsageRecorded({
          feature: command.feature,
          amount: command.amount,
          // Credits are never held, so a settle spends none; the hold commands
          // refuse a credit-priced feature outright.
          cost: 0,
          creditsAfter: state.credits,
          usedAfter: used + command.amount,
          // The units left `remaining` when they were reserved.
          remainingAfter: remaining,
          ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
        }),
        ...allocation.allocations.map((settled) => {
          reservedAfter -= settled.amount;
          return new UsageSettled({
            feature: command.feature,
            amount: settled.amount,
            reservedAfter,
            remainingAfter: remaining,
            ...(settled.reservationId === undefined
              ? {}
              : { reservationId: settled.reservationId }),
          });
        }),
      ];
    },
    ReleaseUsage: (state, command) => {
      if (state._tag !== "Subscribed") {
        return new NoReservation({
          feature: command.feature,
          requested: command.amount,
          reserved: 0,
        });
      }
      const allowance = state.allowances[command.feature];
      // A flag is never held, so there is nothing to return.
      if (allowance !== undefined && isFlagGrant(allowance)) {
        return new FeatureNotMetered({ feature: command.feature });
      }
      if (state.rates[command.feature] !== undefined) {
        return new CreditHoldUnsupported({ feature: command.feature });
      }
      if (command.amount <= 0) return [];
      const reserved = reservedOf(state, command.feature);
      const allocation = allocationsOf(
        state,
        command.feature,
        command.amount,
        command.reservationId,
      );
      if ("rejection" in allocation) return allocation.rejection;
      let reservedAfter = reserved;
      let remainingAfter = remainingOf(state, command.feature);
      return allocation.allocations.map((released) => {
        reservedAfter -= released.amount;
        remainingAfter = remainingAfterRelease(remainingAfter, released.amount);
        return new UsageReleased({
          feature: command.feature,
          amount: released.amount,
          reservedAfter,
          remainingAfter,
          ...(released.reservationId === undefined
            ? {}
            : { reservationId: released.reservationId }),
        });
      });
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
    ConsumeCredits: (state, command, { id }) => {
      if (state._tag !== "Subscribed") return new NotSubscribed({ account: id });
      if (command.amount <= 0) return [];
      if (command.amount > state.credits) {
        return new CreditExceedsBalance({ balance: state.credits, requested: command.amount });
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
      creditsExpire: event.creditsExpire,
      rates: event.rates,
      ...(state._tag === "Subscribed" && state.currency !== undefined
        ? { currency: state.currency }
        : {}),
      ...(event.price === undefined ? {} : { price: event.price }),
      usage: {},
      remaining: event.remaining,
      reserved: {},
      reservations: {},
      reservationSequence: 0,
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
      creditsExpire: event.creditsExpire,
      rates: event.rates,
      ...(event.currency === undefined ? {} : { currency: event.currency }),
      ...(event.price === undefined ? {} : { price: event.price }),
      usage: {},
      remaining: event.remaining,
      reserved: {},
      reservations: {},
      reservationSequence: 0,
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
            usage: { ...state.usage, [event.feature]: event.usedAfter },
            remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
            dedupeKeys:
              event.dedupeKey === undefined
                ? state.dedupeKeys
                : { ...state.dedupeKeys, [event.dedupeKey]: true },
          }
        : state,
    UsageReserved: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const reservations =
        event.reservationId === undefined
          ? reservationsOf(state)
          : {
              ...reservationsOf(state),
              [event.reservationId]: {
                id: event.reservationId,
                feature: event.feature,
                amount: event.amount,
                remaining: event.amount,
              },
            };
      return {
        ...state,
        reservations,
        reservationSequence: event.sequence ?? state.reservationSequence ?? 0,
        reserved: { ...state.reserved, [event.feature]: event.reservedAfter },
        remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
        dedupeKeys:
          event.dedupeKey === undefined
            ? state.dedupeKeys
            : { ...state.dedupeKeys, [event.dedupeKey]: true },
      };
    },
    UsageSettled: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const reservations = { ...reservationsOf(state) };
      if (event.reservationId !== undefined) {
        const reservation = reservations[event.reservationId];
        if (reservation !== undefined) {
          const remaining = reservation.remaining - event.amount;
          if (remaining <= 0) delete reservations[event.reservationId];
          else reservations[event.reservationId] = { ...reservation, remaining };
        }
      }
      return {
        ...state,
        reservations,
        reserved: { ...state.reserved, [event.feature]: event.reservedAfter },
        remaining: { ...state.remaining, [event.feature]: event.remainingAfter },
      };
    },
    UsageReleased: (state, event) => {
      if (state._tag !== "Subscribed") return state;
      const reservations = { ...reservationsOf(state) };
      if (event.reservationId !== undefined) {
        const reservation = reservations[event.reservationId];
        if (reservation !== undefined) {
          const remaining = reservation.remaining - event.amount;
          if (remaining <= 0) delete reservations[event.reservationId];
          else reservations[event.reservationId] = { ...reservation, remaining };
        }
      }
      return {
        ...state,
        reservations,
        reserved: { ...state.reserved, [event.feature]: event.reservedAfter },
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
      state._tag === "Subscribed" ? { ...state, credits: event.balanceAfter } : state,
    CreditsConsumed: (state, event) =>
      state._tag === "Subscribed" ? { ...state, credits: event.balanceAfter } : state,
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
      return {
        ...state,
        usage: Object.fromEntries(
          Object.entries(state.usage).filter(([feature]) => kept[feature] === true),
        ),
        reserved: Object.fromEntries(
          Object.entries(state.reserved).filter(([feature]) => kept[feature] === true),
        ),
        reservations: Object.fromEntries(
          Object.entries(reservationsOf(state)).filter(
            ([, reservation]) => kept[reservation.feature] === true,
          ),
        ),
        remaining: event.remaining,
      };
    },
    // The invoice is the outcome: the log now says what was billed and on what.
    ProrationInvoiced: (state, event) =>
      state._tag === "Subscribed" ? { ...state, prorationInvoice: event.invoiceId } : state,
    CreditsExpired: (state, event) =>
      state._tag === "Subscribed" ? { ...state, credits: event.balanceAfter } : state,
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
    ReserveUsage: (_state, events) => {
      const reserved = events.find((event) => event._tag === "UsageReserved");
      return {
        reservationId:
          reserved?._tag === "UsageReserved" ? (reserved.reservationId ?? "hold:0") : "hold:0",
      };
    },
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
