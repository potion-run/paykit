import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
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

/**
 * The feature is an on/off capability, not a meter. A flag is granted or it is
 * not, so there is no counter to record usage against: `Track`, `Reserve`,
 * `Settle` and `Release` all refuse one with this tag.
 */
export class FeatureNotMetered extends Domain.Rejection("FeatureNotMetered", {
  feature: Schema.String,
}) {}

/** The pool cannot cover what this usage costs. */
export class CreditExceeded extends Domain.Rejection("CreditExceeded", {
  feature: Schema.String,
  /** What the usage costs in credits: `amount × rate`. */
  cost: Schema.Int,
  /** The pool at the moment it was refused, untouched. */
  balance: Schema.Int,
}) {}

/**
 * One usage fact. `remainingAfter` is the outcome `decide` worked out, and is
 * `null` when there is no count: an allowance that never runs out, or a
 * credit-priced feature whose count is the shared pool. `cost` is the credits
 * the usage spent (`0` for a feature counted in its own units), and
 * `creditsAfter` is the pool it left behind, so replaying the log reproduces
 * the balance.
 */
export class UsageRecorded extends Domain.Event("UsageRecorded", {
  feature: Schema.String,
  amount: Schema.Int,
  cost: Schema.Int,
  creditsAfter: Schema.Int,
  usedAfter: Schema.Int,
  remainingAfter: Schema.NullOr(Schema.Int),
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
    /** Which rate prices this usage. Omitted means the card's `"default"`. */
    dimension: Schema.optionalKey(Schema.String),
    dedupeKey: Schema.optionalKey(Schema.String),
  },
  events: [UsageRecorded],
  rejects: [AllowanceExceeded, StandingBlocksUsage, FeatureNotMetered, CreditExceeded],
  middleware: [Session],
}) {}
