import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { CreditsExpired } from "./ClosePeriod.command.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { RefundRecorded, RefundExceedsCharged } from "./Refund.command.ts";
import { UsageReleased } from "./ReleaseHold.command.ts";
import { StandingEnded } from "./StandingEnded.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The money a provider already sent back for an immediate cancellation. */
export const ImmediateRefund = Schema.Struct({
  /** The provider's reference for what is being refunded. */
  chargeId: Schema.String,
  /** The provider's id for the refund it took. */
  refundId: Schema.String,
  amount: Schema.Int,
  currency: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});

export type ImmediateRefund = typeof ImmediateRefund.Type;

/** The standing ended immediately, rather than at a boundary. */
export class SubscriptionCanceled extends Domain.Event("SubscriptionCanceled", {
  canceledAt: Schema.DateTimeUtc,
  statusAfter: Schema.Literal("canceled"),
}) {}

/**
 * End a standing now. The command releases open holds, expires the plan's own
 * credits and, when the provider already refunded, records that refund in the
 * same transaction. A lifetime pack is left alone.
 *
 * The provider call belongs before this command: `Update` computes the unused
 * part of the plan price and asks `Payments.refund` for it, then sends the
 * refund id here. A cancellation without a refund is still valid for a free
 * plan or a deployment that collects the money another way.
 */
export class CancelImmediately extends Domain.Command("CancelImmediately", {
  target: AccountId,
  input: {
    refund: Schema.optionalKey(ImmediateRefund),
  },
  events: [SubscriptionCanceled, UsageReleased, CreditsExpired, RefundRecorded],
  rejects: [NotSubscribed, StandingEnded, RefundExceedsCharged],
  middleware: [Session],
}) {}
