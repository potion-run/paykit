import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { FeatureNotConsumable } from "./FeatureNotConsumable.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";
import { StandingBlocksUsage } from "./TrackUsage.command.ts";

/** An occupancy count cannot be negative. */
export class UsageInvalid extends Domain.Rejection("UsageInvalid", {
  feature: Schema.String,
  usage: Schema.Int,
}) {}

/**
 * The number of a non-consumable feature in use changed. Occupancy is separate
 * from the purchased quantity: lowering the purchase below occupancy leaves a
 * negative balance rather than removing anyone's seat (ADR 0036).
 */
export class UsageSet extends Domain.Event("UsageSet", {
  feature: Schema.String,
  occupiedBefore: Schema.Int,
  occupiedAfter: Schema.Int,
  /**
   * What the feature has left after the change: `purchased - occupied`. It may
   * be negative, and it is what `check()` compares a request against.
   */
  remainingAfter: Schema.Int,
}) {}

/**
 * Set how much of a non-consumable feature is in use. A seat is occupied, not
 * spent: this never bills, never resets at a boundary and never changes the
 * purchased quantity.
 *
 * Occupancy may exceed the purchase. The balance then blocks new occupancy while
 * the people already holding a seat keep working; the customer sees a negative
 * `remaining` and can buy the seats back.
 *
 * Setting the same occupancy twice records nothing, so the binding can derive a
 * stable command id from the feature and the count.
 */
export class SetUsage extends Domain.Command("SetUsage", {
  target: AccountId,
  input: {
    feature: Schema.String,
    /** The number in use. A count, not a purchase and not a spend. */
    usage: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  },
  events: [UsageSet],
  rejects: [
    NotSubscribed,
    FeatureNotConsumable,
    UsageInvalid,
    StandingBlocksUsage,
    Unauthenticated,
    Forbidden,
  ],
  reply: {
    usage: Schema.Int,
    remaining: Schema.Int,
  },
  middleware: [Session],
}) {}
