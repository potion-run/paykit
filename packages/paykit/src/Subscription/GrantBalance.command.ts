import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { FeatureNotConsumable } from "./FeatureNotConsumable.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { FeatureNotMetered } from "./TrackUsage.command.ts";

/** A grant that is not for a priced-in-credits feature. */
export class FeaturePricedInCredits extends Domain.Rejection("FeaturePricedInCredits", {
  feature: Schema.String,
}) {}

/** A grant needs a count to add to; an unlimited allowance has none. */
export class FeatureNotCounted extends Domain.Rejection("FeatureNotCounted", {
  feature: Schema.String,
}) {}

/** A grant's expiry is not in the future, so it would be dead on arrival. */
export class GrantExpiryNotLater extends Domain.Rejection("GrantExpiryNotLater", {
  expiresAt: Schema.DateTimeUtc,
  now: Schema.DateTimeUtc,
}) {}

/**
 * A standalone balance grant was created. It belongs to the customer, not to
 * the plan: the plan and rollover sources are spent before it, and a lifetime
 * grant survives every close and plan change (ADR 0037).
 */
export class BalanceGranted extends Domain.Event("BalanceGranted", {
  feature: Schema.String,
  /** The command id, so a retry is one grant rather than two. */
  grantId: Schema.String,
  granted: Schema.Int,
  /** The deadline an expiring grant ends at; absent means it never expires. */
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** The plan that was active when the grant was created. */
  planId: Schema.optionalKey(Schema.String),
  /** The whole spendable count after the grant. */
  remainingAfter: Schema.Int,
}) {}

/**
 * Create a standalone grant of a counted feature. `balances.create` sends it.
 * A grant is consumed last, after the plan and rollover, and a lifetime grant
 * outlives the plan that was active when it was made.
 *
 * A grant is not a plan item: it has no price, no period and no reset. A
 * resetting grant is an add-on plan item, which is a later slice.
 */
export class GrantBalance extends Domain.Command("GrantBalance", {
  target: AccountId,
  input: {
    feature: Schema.String,
    /** The units to grant. A grant of zero or less records nothing. */
    granted: Schema.Int,
    /** An optional deadline; omitted, the grant never expires. */
    expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  },
  events: [BalanceGranted],
  rejects: [
    NotSubscribed,
    FeatureNotConsumable,
    FeatureNotMetered,
    FeaturePricedInCredits,
    FeatureNotCounted,
    GrantExpiryNotLater,
  ],
  reply: {
    granted: Schema.Int,
    balance: Schema.Int,
  },
  middleware: [Session],
}) {}
