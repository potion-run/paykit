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
  /** Credits open holds reserved; `balance - reserved` is what could be spent. */
  reserved: Schema.optionalKey(Schema.Int),
}) {}

/**
 * The usage would pass the period's ceiling: `included + cap` units billed and
 * held. The account is not in trouble — it has used what it bought — so this is
 * a refusal about quantity, not about standing.
 */
export class SpendCapExceeded extends Domain.Rejection("SpendCapExceeded", {
  feature: Schema.String,
  /** The units this period may bill past `included`. */
  cap: Schema.Int,
  used: Schema.Int,
  /** Held by open holds, which count against the ceiling too. */
  reserved: Schema.Int,
  requested: Schema.Int,
}) {}

/**
 * The usage would bill more money than the allowance permits this period,
 * `billed + charge > moneyCap`. Like a quantity ceiling this is the account
 * running out of what it bought, so `standing` stays `good`.
 */
export class MoneyCapExceeded extends Domain.Rejection("MoneyCapExceeded", {
  feature: Schema.String,
  /** The most this feature may bill in one period, in minor units. */
  cap: Schema.Int,
  /** What this feature has already billed this period. */
  billed: Schema.Int,
  /** Money open holds have promised to bill, when any are open. */
  reserved: Schema.optionalKey(Schema.Int),
  /** What this event would add. */
  charge: Schema.Int,
}) {}

/**
 * One usage fact. `remainingAfter` is the outcome `decide` worked out, and is
 * `null` when there is no count: an allowance that never runs out, or a
 * credit-priced feature whose count is the shared pool. `cost` is the credits
 * the usage spent (`0` for a feature counted in its own units), and
 * `creditsAfter` is the pool it left behind, so replaying the log reproduces
 * the balance. `charge` is the money this event billed, and `billedAfter` the
 * feature's period total; both are absent when the allowance has no unit price.
 */
export class UsageRecorded extends Domain.Event("UsageRecorded", {
  feature: Schema.String,
  amount: Schema.Int,
  cost: Schema.Int,
  creditsAfter: Schema.Int,
  usedAfter: Schema.Int,
  remainingAfter: Schema.NullOr(Schema.Int),
  /** Money this event billed, in minor units. Absent when there is no unit price. */
  charge: Schema.optionalKey(Schema.Int),
  /** The feature's billed total this period after this event. */
  billedAfter: Schema.optionalKey(Schema.Int),
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
  rejects: [
    AllowanceExceeded,
    StandingBlocksUsage,
    FeatureNotMetered,
    CreditExceeded,
    SpendCapExceeded,
    MoneyCapExceeded,
  ],
  middleware: [Session],
}) {}
