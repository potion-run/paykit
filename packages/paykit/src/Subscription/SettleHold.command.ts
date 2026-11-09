import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { HoldExceeded, HoldExpired, HoldSettled, HoldUnknown } from "./Hold.command.ts";
import { AccountId } from "./Subscription.id.ts";
import { MoneyCapExceeded, StandingBlocksUsage, UsageRecorded } from "./TrackUsage.command.ts";

/**
 * A hold became usage. `amount` units were billed and `released` returned, so
 * the hold is closed either way; `cost` is the credits the whole hold kept out
 * of the pool, which settle gives back and bills only `amount × rate` of.
 */
export class UsageSettled extends Domain.Event("UsageSettled", {
  holdId: Schema.String,
  feature: Schema.String,
  /** Units billed: what the work actually used. */
  amount: Schema.Int,
  /** Units returned to the allowance in the same command. */
  released: Schema.Int,
  /** Credits the hold reserved; `0` for a feature counted in its own units. */
  cost: Schema.Int,
  remainingAfter: Schema.NullOr(Schema.Int),
  /** The grant units the released part of the hold returned, keyed by grant id. */
  grantsReturned: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
}) {}

/**
 * Turn a hold into usage. `amount` defaults to the whole hold; whatever is left
 * returns in the same command, so a caller cannot hold and forget.
 *
 * Settling a hold that is already settled records nothing — the work is
 * already billed, and `UsageSettled` carrying the id makes the command id
 * derivable. Settling a released hold is `HoldSettled`, an id nobody issued is
 * `HoldUnknown`, and a hold past `expiresAt` is `HoldExpired`.
 */
export class SettleHold extends Domain.Command("SettleHold", {
  target: AccountId,
  input: {
    holdId: Schema.String,
    /** Units to bill. Omitted settles the whole hold. */
    amount: Schema.optionalKey(Schema.Int),
    dedupeKey: Schema.optionalKey(Schema.String),
  },
  events: [UsageRecorded, UsageSettled],
  rejects: [
    HoldUnknown,
    HoldSettled,
    HoldExpired,
    HoldExceeded,
    StandingBlocksUsage,
    MoneyCapExceeded,
  ],
  // What this command billed and returned. A caller reading it over a transport
  // gets the money the event recorded, not a second guess from the read model.
  reply: { billed: Schema.Int, released: Schema.Int, feature: Schema.String },
  middleware: [Session],
}) {}
