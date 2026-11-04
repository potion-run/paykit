import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Subscription.id.ts";

/** There is no unbilled tier change to charge, or this one already was. */
export class NoProrationDue extends Domain.Rejection("NoProrationDue", {
  account: Schema.String,
  /** `none` when no tier change moved money, `billed` when it already did. */
  reason: Schema.Literals(["none", "billed"]),
}) {}

/** The proration a tier change moved was billed on a provider invoice. */
export class ProrationInvoiced extends Domain.Event("ProrationInvoiced", {
  invoiceId: Schema.String,
  amount: Schema.Int,
  currency: Schema.String,
}) {}

/**
 * Record the invoice a positive proration was billed on.
 *
 * It is a command rather than a state write because the log must carry the
 * money that moved: an upgrade whose invoice is only on the provider is a
 * charge nobody can audit from paykit's own events.
 */
export class RecordProrationInvoice extends Domain.Command("RecordProrationInvoice", {
  target: AccountId,
  input: {
    invoiceId: Schema.String,
    amount: Schema.Int,
    currency: Schema.String,
  },
  events: [ProrationInvoiced],
  rejects: [NoProrationDue],
}) {}
