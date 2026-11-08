import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { AccountId } from "./Subscription.id.ts";

/** The refund a reversal names is not in the log. */
export class RefundNotFound extends Domain.Rejection("RefundNotFound", {
  /** The provider's id the caller named. */
  refundId: Schema.String,
}) {}

/** A reversal is larger than the part of its refund that has not already been reversed. */
export class RefundReversalExceedsRefunded extends Domain.Rejection(
  "RefundReversalExceedsRefunded",
  {
    /** The refund being reversed. */
    refundId: Schema.String,
    /** What that refund recorded, in minor units. */
    refunded: Schema.Int,
    /** How much of it already came back. */
    reversed: Schema.Int,
    /** What this reversal asked for. */
    requested: Schema.Int,
  },
) {}

/**
 * Money that a provider had acknowledged as refunded came back to paykit's side:
 * an ACH return, a refund to a closed card, a chargeback the merchant lost. The
 * refund did happen, so `RefundRecorded` stays; this is the second fact, and it
 * is what makes the currency's refundable headroom the truth again (ADR 0027).
 */
export class RefundReversed extends Domain.Event("RefundReversed", {
  /** The provider's id for the refund that came back. */
  refundId: Schema.String,
  /** Minor units that came back. May be less than the refund recorded. */
  amount: Schema.Int,
  currency: Schema.String,
  /** The currency's refunded total after this reversal, so a replay needs no sum. */
  refundedAfter: Schema.Int,
  /** Why it came back: the provider's code, or an operator's note. */
  reason: Schema.optionalKey(Schema.String),
  /**
   * The operator action, or the provider delivery, that recorded this. A retry
   * is the same command id, so a redelivery reverses once.
   */
  commandId: Schema.String,
}) {}

/**
 * Record a refund the provider reversed.
 *
 * The cap is the refund being reversed, not the currency: two refunds of one
 * charge are two facts, and reversing the second must not be refused because
 * the first is still standing. The credit pool is untouched — a refund is money,
 * and its reversal is money coming back, so revoking credits stays a separate
 * `ConsumeCredits` (ADR 0019, ADR 0027).
 *
 * No provider call: the money already moved back, and this records that it did.
 * That is why the command can live on the operator Api, unlike `Refund` whose
 * provider call is why its binding sits in the process that holds the provider.
 */
export class ReverseRefund extends Domain.Command("ReverseRefund", {
  target: AccountId,
  input: {
    /** The provider's id for the refund that came back. */
    refundId: Schema.String,
    /** Minor units. A non-positive amount records nothing. */
    amount: Schema.Int,
    reason: Schema.optionalKey(Schema.String),
  },
  events: [RefundReversed],
  rejects: [RefundNotFound, RefundReversalExceedsRefunded],
  middleware: [Admin],
}) {}
