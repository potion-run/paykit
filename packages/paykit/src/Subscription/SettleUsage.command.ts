import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { AccountId } from "./Subscription.id.ts";
import { StandingBlocksUsage, UsageRecorded } from "./TrackUsage.command.ts";

/** No open reservation covers the amount being settled. */
export class NoReservation extends Domain.Rejection("NoReservation", {
  feature: Schema.String,
  requested: Schema.Int,
  reserved: Schema.Int,
}) {}

/**
 * A reservation became real usage. `remaining` does not move: the units left
 * it when they were reserved, so this only bills them.
 */
export class UsageSettled extends Domain.Event("UsageSettled", {
  feature: Schema.String,
  amount: Schema.Int,
  reservedAfter: Schema.Int,
  remainingAfter: Schema.Int,
}) {}

/**
 * Turn a held reservation into usage, recording one `UsageRecorded` for it so
 * counters stay a fold of a single event kind. Settling more than is held is
 * refused: a caller that spent more than it reserved sends `TrackUsage` for
 * the difference, which is where the allowance is judged.
 */
export class SettleUsage extends Domain.Command("SettleUsage", {
  target: AccountId,
  input: {
    feature: Schema.String,
    amount: Schema.Int,
    dedupeKey: Schema.optionalKey(Schema.String),
  },
  events: [UsageRecorded, UsageSettled],
  rejects: [NoReservation, StandingBlocksUsage],
  middleware: [Session],
}) {}
