import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { PlanGroupCanceled } from "./CancelGroup.command.ts";
import { PlanChanged } from "./ChangeTier.command.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { UsageReleased } from "./ReleaseHold.command.ts";
import { PlanItemReset } from "./ResetAllowance.command.ts";
import { AccountId } from "./Subscription.id.ts";
import {
  Standing,
  SubscriptionStatus,
  type SubscribedState,
  rollsPeriod,
} from "./Subscription.state.ts";

/** The period is not over yet, it was already closed, or the standing has ended. */
export class PeriodNotClosed extends Domain.Rejection("PeriodNotClosed", {
  periodEnd: Schema.DateTimeUtc,
  now: Schema.DateTimeUtc,
}) {}

/** The period ended and the next one opened, or the standing ended. */
export class PeriodClosed extends Domain.Event("PeriodClosed", {
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  nextPeriodStart: Schema.DateTimeUtc,
  nextPeriodEnd: Schema.DateTimeUtc,
  statusAfter: SubscriptionStatus,
  standingAfter: Standing,
  cancelAtPeriodEndAfter: Schema.Boolean,
  /**
   * The pool the next period starts with, when a landing plan grants one. A
   * phase applied by its own deadline has already moved the plan, so this is
   * the only event that carries the new grant into the close.
   */
  credits: Schema.optionalKey(Schema.Int),
  /** The part of that pool a one-off pack bought. */
  prepaidCredits: Schema.optionalKey(Schema.Int),
}) {}

/**
 * Usage counters returned to zero, and the allowance the next period starts
 * with. `remaining` is the outcome after reset, and is `null` for a feature
 * with no count. `carried` is how much of that rolled over from the period that
 * just closed — `0` for a feature that carried nothing. `kept` marks a
 * counted `resets: "never"` feature whose usage and open reservations survive
 * the boundary; absent means every feature reset.
 */
export class UsageReset extends Domain.Event("UsageReset", {
  remaining: Schema.Record(Schema.String, Schema.NullOr(Schema.Int)),
  carried: Schema.Record(Schema.String, Schema.Int),
  kept: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
}) {}

/** Credits do not survive a period boundary. */
export class CreditsExpired extends Domain.Event("CreditsExpired", {
  amount: Schema.Int,
  balanceAfter: Schema.Int,
}) {}

/** Whether this is the open period and its end has been reached. */
export const canClosePeriod = (
  state: SubscribedState,
  periodEnd: DateTime.Utc,
  now: DateTime.Utc,
): boolean =>
  rollsPeriod(state.status) &&
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(periodEnd) &&
  DateTime.toEpochMillis(periodEnd) === DateTime.toEpochMillis(state.period.end) &&
  (state.lastClosedPeriodStart === undefined ||
    DateTime.toEpochMillis(state.lastClosedPeriodStart) !==
      DateTime.toEpochMillis(state.period.start));

/**
 * Close the period that ended at `periodEnd`, reset usage and expire credits.
 * A scheduled caller only fires once the period is actually over.
 */
export class ClosePeriod extends Domain.Command("ClosePeriod", {
  target: AccountId,
  input: { periodEnd: Schema.DateTimeUtc },
  // A scheduled tier change lands before the reset, so the new tier's
  // allowances are the ones the next period starts on.
  events: [
    PlanChanged,
    PlanGroupCanceled,
    PlanItemReset,
    UsageReleased,
    PeriodClosed,
    UsageReset,
    CreditsExpired,
  ],
  rejects: [NotSubscribed, PeriodNotClosed],
}) {}
