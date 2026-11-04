import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Subscription.id.ts";
import { Standing } from "./Subscription.state.ts";

/** A blocking allowance has no room for the request. */
export class AllowanceExceeded extends Domain.Rejection("AllowanceExceeded", {
  feature: Schema.String,
  included: Schema.Int,
  used: Schema.Int,
  requested: Schema.Int,
  remaining: Schema.Int,
}) {}

/** The account's standing forbids usage altogether. */
export class StandingBlocksUsage extends Domain.Rejection("StandingBlocksUsage", {
  standing: Standing,
  status: Schema.String,
}) {}

/** One usage fact. `remainingAfter` is the outcome `decide` worked out. */
export class UsageRecorded extends Domain.Event("UsageRecorded", {
  feature: Schema.String,
  amount: Schema.Int,
  usedAfter: Schema.Int,
  remainingAfter: Schema.Int,
  dedupeKey: Schema.optionalKey(Schema.String),
}) {}

/**
 * Record one usage fact, deduped by key, in the same transaction that checks
 * the allowance. A `block` allowance refuses before anything is written.
 */
export class TrackUsage extends Domain.Command("TrackUsage", {
  target: AccountId,
  input: {
    feature: Schema.String,
    amount: Schema.Int,
    dedupeKey: Schema.optionalKey(Schema.String),
  },
  events: [UsageRecorded],
  rejects: [AllowanceExceeded, StandingBlocksUsage],
}) {}
