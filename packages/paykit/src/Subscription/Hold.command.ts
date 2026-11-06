import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { FeatureNotConsumable } from "./FeatureNotConsumable.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import {
  FeatureNotMetered,
  MoneyCapExceeded,
  SpendCapExceeded,
  StandingBlocksUsage,
} from "./TrackUsage.command.ts";

/** How long a hold lives unless the caller says otherwise. */
export const HOLD_TTL_MINUTES = 15;

/** A hold that never expires: asked for, never assumed. */
export const defaultHoldExpiry = (now: DateTime.Utc): DateTime.Utc =>
  DateTime.add(now, { minutes: HOLD_TTL_MINUTES });

/** The hold asks for more than there is room for, or more than it holds. */
export class HoldExceeded extends Domain.Rejection("HoldExceeded", {
  /** The hold being settled; absent when a hold is being placed. */
  holdId: Schema.optionalKey(Schema.String),
  feature: Schema.String,
  /** Units (or credits) asked for. */
  requested: Schema.Int,
  /** What the hold holds: `0` when nothing exists yet. */
  held: Schema.Int,
  /** Spendable now: a feature's count, or the pool minus held credits. */
  remaining: Schema.Int,
}) {}

/** No hold with this id was ever issued, in this standing. */
export class HoldUnknown extends Domain.Rejection("HoldUnknown", {
  holdId: Schema.String,
}) {}

/** The hold has already been turned into usage, so it cannot be released. */
export class HoldSettled extends Domain.Rejection("HoldSettled", {
  holdId: Schema.String,
  feature: Schema.String,
}) {}

/** The hold outlived `expiresAt`, so it can be released but not billed. */
export class HoldExpired extends Domain.Rejection("HoldExpired", {
  holdId: Schema.String,
  feature: Schema.String,
  expiresAt: Schema.DateTimeUtc,
  now: Schema.DateTimeUtc,
}) {}

/**
 * Units (or credits) are held for work that has started but not finished. The
 * event carries the whole hold, so a redelivery rebuilds the same entity, and
 * the rate it was priced at, so a catalog change mid-flight does not reprice
 * work already priced.
 */
export class UsageReserved extends Domain.Event("UsageReserved", {
  holdId: Schema.String,
  feature: Schema.String,
  amount: Schema.Int,
  dimension: Schema.optionalKey(Schema.String),
  /** Credits one unit was priced at when the hold was taken; `0` if counted. */
  rate: Schema.Int,
  /** The credits the hold keeps out of the pool: `amount × rate`. */
  cost: Schema.Int,
  at: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  /** What the feature has left once these units are held. */
  remainingAfter: Schema.NullOr(Schema.Int),
  dedupeKey: Schema.optionalKey(Schema.String),
}) {}

/**
 * Hold capacity for work that is about to happen: an agent turn, a long job, a
 * request whose cost is known up front. The command carries its own `holdId`,
 * so the caller can settle or release exactly this hold and a retry with the
 * same id is a replay.
 *
 * A hold past a blocking allowance — or past the pool, on a credit-priced
 * feature — is refused in the same transaction.
 */
export class Hold extends Domain.Command("Hold", {
  target: AccountId,
  input: {
    holdId: Schema.String,
    feature: Schema.String,
    amount: Schema.Int,
    /** Which rate prices the units, for a credit-priced feature. */
    dimension: Schema.optionalKey(Schema.String),
    /** The event's properties, which a rate card's rules and multipliers match. */
    properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    /** Defaults to `HOLD_TTL_MINUTES` after the command's clock. */
    expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
    dedupeKey: Schema.optionalKey(Schema.String),
  },
  events: [UsageReserved],
  rejects: [
    HoldExceeded,
    StandingBlocksUsage,
    FeatureNotMetered,
    FeatureNotConsumable,
    SpendCapExceeded,
    MoneyCapExceeded,
  ],
  middleware: [Session],
}) {}
