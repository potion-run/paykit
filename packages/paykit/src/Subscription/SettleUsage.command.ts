import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { CreditHoldUnsupported } from "./ReserveUsage.command.ts";
import { AccountId } from "./Subscription.id.ts";
import { FeatureNotMetered, StandingBlocksUsage, UsageRecorded } from "./TrackUsage.command.ts";

/** No open reservation covers the amount being settled. */
export class NoReservation extends Domain.Rejection("NoReservation", {
  feature: Schema.String,
  requested: Schema.Int,
  reserved: Schema.Int,
  /** Present when the caller named one hold instead of an amount. */
  reservationId: Schema.optionalKey(Schema.String),
}) {}

/**
 * A reservation became real usage. `remaining` does not move: the units left
 * it when they were reserved, so this only bills them. `reservationId` names
 * the hold this settled; absent only on events recorded before holds had ids.
 */
export class UsageSettled extends Domain.Event("UsageSettled", {
  feature: Schema.String,
  amount: Schema.Int,
  reservedAfter: Schema.Int,
  remainingAfter: Schema.NullOr(Schema.Int),
  reservationId: Schema.optionalKey(Schema.String),
}) {}

/**
 * Turn a held reservation into usage, recording one `UsageRecorded` for it so
 * counters stay a fold of a single event kind. Settling more than is held is
 * refused: a caller that spent more than it reserved sends `TrackUsage` for
 * the difference, which is where the allowance is judged.
 *
 * `reservationId` settles exactly that hold. Without one, the amount consumes
 * open holds first-in-first-out; a caller that never held anything is refused.
 */
export class SettleUsage extends Domain.Command("SettleUsage", {
  target: AccountId,
  input: {
    feature: Schema.String,
    amount: Schema.Int,
    reservationId: Schema.optionalKey(Schema.String),
    dedupeKey: Schema.optionalKey(Schema.String),
  },
  events: [UsageRecorded, UsageSettled],
  rejects: [NoReservation, StandingBlocksUsage, FeatureNotMetered, CreditHoldUnsupported],
  middleware: [Session],
}) {}
