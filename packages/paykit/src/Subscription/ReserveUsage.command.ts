import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { AccountId } from "./Subscription.id.ts";
import { StandingBlocksUsage } from "./TrackUsage.command.ts";

/** The spendable amount is smaller than the reservation asked for. */
export class ReservationExceeded extends Domain.Rejection("ReservationExceeded", {
  feature: Schema.String,
  included: Schema.Int,
  used: Schema.Int,
  /** Already held by other open reservations. */
  reserved: Schema.Int,
  requested: Schema.Int,
  remaining: Schema.Int,
}) {}

/**
 * A reservation took units out of `remaining` without recording usage. The
 * work they fund has started but has not finished, so `SettleUsage` bills them
 * and `ReleaseUsage` returns them.
 */
export class UsageReserved extends Domain.Event("UsageReserved", {
  feature: Schema.String,
  amount: Schema.Int,
  reservedAfter: Schema.Int,
  remainingAfter: Schema.Int,
  dedupeKey: Schema.optionalKey(Schema.String),
}) {}

/**
 * Hold allowance for work that is about to happen: an agent turn, a long job,
 * a request whose cost is known up front. A reservation is refused exactly
 * like a `TrackUsage` past a blocking allowance, so two concurrent callers
 * cannot both spend the last unit.
 *
 * Send it with the same `dedupeKey` on retry, so a retry holds once.
 */
export class ReserveUsage extends Domain.Command("ReserveUsage", {
  target: AccountId,
  input: {
    feature: Schema.String,
    amount: Schema.Int,
    dedupeKey: Schema.optionalKey(Schema.String),
  },
  events: [UsageReserved],
  rejects: [ReservationExceeded, StandingBlocksUsage],
  middleware: [Session],
}) {}
