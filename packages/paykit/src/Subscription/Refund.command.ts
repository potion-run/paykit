import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { AccountId } from "./Subscription.id.ts";

/** A refund is larger than the money paykit recorded as charged in its currency. */
export class RefundExceedsCharged extends Domain.Rejection("RefundExceedsCharged", {
  currency: Schema.String,
  /** Minor units the account was charged in this currency, as the log records it. */
  charged: Schema.Int,
  /** Minor units already refunded in this currency. */
  refunded: Schema.Int,
  /** What this refund asked for. */
  requested: Schema.Int,
}) {}

/**
 * Money went back to the customer. The charge is what the operator refunded, as
 * the provider names it; the refund is what the provider returned. Neither is a
 * foreign key into paykit's own records — a checkout purchase carries a price
 * and no vendor reference, so the cap is the account's charged total per
 * currency (ADR 0019).
 */
export class RefundRecorded extends Domain.Event("RefundRecorded", {
  /** The provider's reference for what was refunded, as the operator gave it. */
  chargeId: Schema.String,
  /** The provider's id for the refund it took. */
  refundId: Schema.String,
  /** Minor units refunded. */
  amount: Schema.Int,
  currency: Schema.String,
  /**
   * The id of the operator action that recorded this refund. A retry is the
   * same command id, so a redelivery resolves to this refund instead of asking
   * the ceiling for headroom the first attempt already spent.
   */
  commandId: Schema.String,
  /** Why the money went back, as an operator would tell a customer. */
  reason: Schema.optionalKey(Schema.String),
  /** The currency's refunded total after this refund, so a replay needs no sum. */
  refundedAfter: Schema.Int,
}) {}

/**
 * Record money going back to the customer.
 *
 * A refund is an operator's act, not a customer's command, and it never touches
 * the credit pool: revoking credits a refund should not leave spendable is
 * `ConsumeCredits`, which an operator may send separately, so the log keeps
 * "money left" and "credits were burned" apart. The provider call happens in the
 * `Refund` binding, before this command, and its `refundId` is the evidence this
 * event carries.
 *
 * The cap is what paykit recorded as charged: a refund cannot exceed the money
 * the log knows about in its currency (`RefundExceedsCharged`), which is the same
 * shape as a spend cap — a ceiling, not a change to the standing.
 */
export class Refund extends Domain.Command("Refund", {
  target: AccountId,
  input: {
    /** The provider's reference for what is being refunded. */
    chargeId: Schema.String,
    /** The provider's id for the refund it took. */
    refundId: Schema.String,
    /** Minor units. A non-positive amount records nothing. */
    amount: Schema.Int,
    currency: Schema.String,
    reason: Schema.optionalKey(Schema.String),
  },
  events: [RefundRecorded],
  rejects: [RefundExceedsCharged],
  middleware: [Admin],
}) {}
