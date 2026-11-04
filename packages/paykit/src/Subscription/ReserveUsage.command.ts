import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { AccountId } from "./Subscription.id.ts";
import { FeatureNotMetered, StandingBlocksUsage } from "./TrackUsage.command.ts";

/**
 * The feature is priced in credits. Holding credits is a later slice, so the
 * three hold commands refuse rather than pretend to hold units that do not
 * exist.
 */
export class CreditHoldUnsupported extends Domain.Rejection("CreditHoldUnsupported", {
  feature: Schema.String,
}) {}

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

/** A caller supplied a reservation id that is already open. */
export class ReservationExists extends Domain.Rejection("ReservationExists", {
  reservationId: Schema.String,
}) {}

/**
 * A reservation took units out of `remaining` without recording usage. The
 * work they fund has started but has not finished, so `SettleUsage` bills them
 * and `ReleaseUsage` returns them. The event carries the id that makes one hold
 * addressable, and the sequence it advanced so replay is deterministic.
 */
export class UsageReserved extends Domain.Event("UsageReserved", {
  feature: Schema.String,
  amount: Schema.Int,
  reservedAfter: Schema.Int,
  remainingAfter: Schema.NullOr(Schema.Int),
  reservationId: Schema.optionalKey(Schema.String),
  sequence: Schema.optionalKey(Schema.Int),
  dedupeKey: Schema.optionalKey(Schema.String),
}) {}

/**
 * Hold allowance for work that is about to happen: an agent turn, a long job,
 * a request whose cost is known up front. A reservation is refused exactly
 * like a `TrackUsage` past a blocking allowance, so two concurrent callers
 * cannot both spend the last unit.
 *
 * Send it with the same `dedupeKey` on retry, so a retry holds once. The
 * command replies with the reservation id a caller uses to settle or release
 * exactly this hold.
 */
export class ReserveUsage extends Domain.Command("ReserveUsage", {
  target: AccountId,
  input: {
    feature: Schema.String,
    amount: Schema.Int,
    reservationId: Schema.optionalKey(Schema.String),
    dedupeKey: Schema.optionalKey(Schema.String),
  },
  events: [UsageReserved],
  rejects: [
    ReservationExceeded,
    ReservationExists,
    StandingBlocksUsage,
    FeatureNotMetered,
    CreditHoldUnsupported,
  ],
  reply: { reservationId: Schema.String },
  middleware: [Session],
}) {}
