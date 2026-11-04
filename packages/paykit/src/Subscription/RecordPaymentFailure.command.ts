import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { AccountId } from "./Subscription.id.ts";

/** A charge failed; the account keeps service until `graceUntilAfter`. */
export class PaymentFailed extends Domain.Event("PaymentFailed", {
  reason: Schema.String,
  graceUntilAfter: Schema.DateTimeUtc,
  statusAfter: Schema.Literal("grace"),
  attempt: Schema.Int,
}) {}

/**
 * Record a failed charge. No rejection: a provider webhook may arrive for an
 * account that never activated, and that is a no-op rather than an error.
 */
export class RecordPaymentFailure extends Domain.Command("RecordPaymentFailure", {
  target: AccountId,
  input: {
    reason: Schema.String,
    graceUntil: Schema.DateTimeUtc,
  },
  events: [PaymentFailed],
  rejects: [],
  middleware: [Admin],
}) {}
