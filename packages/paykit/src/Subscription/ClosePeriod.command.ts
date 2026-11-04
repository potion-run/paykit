import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { Standing, SubscriptionStatus } from "./Subscription.state.ts";

/** The period is not over yet, or it was already closed. */
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
}) {}

/**
 * Usage counters returned to zero, and the allowance the next period starts
 * with. `remaining` is the outcome after reset, and is `null` for a feature
 * with no count. `carried` is how much of that rolled over from the period that
 * just closed — `0` for a feature that carried nothing.
 */
export class UsageReset extends Domain.Event("UsageReset", {
  remaining: Schema.Record(Schema.String, Schema.NullOr(Schema.Int)),
  carried: Schema.Record(Schema.String, Schema.Int),
}) {}

/** Credits do not survive a period boundary. */
export class CreditsExpired extends Domain.Event("CreditsExpired", {
  amount: Schema.Int,
  balanceAfter: Schema.Int,
}) {}

/** Whether this is the open period and its end has been reached. */
export const canClosePeriod = (
  state: { readonly _tag: string },
  periodEnd: DateTime.Utc,
  now: DateTime.Utc,
): boolean => {
  if (state._tag !== "Subscribed") return false;
  const current = state as unknown as {
    readonly _tag: "Subscribed";
    readonly period: { readonly start: DateTime.Utc; readonly end: DateTime.Utc };
    readonly lastClosedPeriodStart?: DateTime.Utc;
  };
  return (
    DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(periodEnd) &&
    DateTime.toEpochMillis(periodEnd) === DateTime.toEpochMillis(current.period.end) &&
    (current.lastClosedPeriodStart === undefined ||
      DateTime.toEpochMillis(current.lastClosedPeriodStart) !==
        DateTime.toEpochMillis(current.period.start))
  );
};

/**
 * Close the period that ended at `periodEnd`, reset usage and expire credits.
 * A scheduled caller only fires once the period is actually over.
 */
export class ClosePeriod extends Domain.Command("ClosePeriod", {
  target: AccountId,
  input: { periodEnd: Schema.DateTimeUtc },
  events: [PeriodClosed, UsageReset, CreditsExpired],
  rejects: [NotSubscribed, PeriodNotClosed],
}) {}
