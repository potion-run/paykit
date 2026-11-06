import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Subscription.id.ts";

/** There is no unbilled quantity change to charge, or this one already was. */
export class NoQuantityProrationDue extends Domain.Rejection("NoQuantityProrationDue", {
  account: Schema.String,
  prorationId: Schema.String,
  /** `none` when no quantity change moved money, `billed` when it already did. */
  reason: Schema.Literals(["none", "billed"]),
}) {}

/** The money a quantity change moved was billed on a provider invoice. */
export class QuantityProrationInvoiced extends Domain.Event("QuantityProrationInvoiced", {
  prorationId: Schema.String,
  invoiceId: Schema.String,
  amount: Schema.Int,
  currency: Schema.String,
}) {}

/**
 * Record the invoice a positive quantity proration was billed on. Like a tier
 * change's invoice, it is a command so the log carries the money that moved.
 */
export class RecordQuantityProrationInvoice extends Domain.Command(
  "RecordQuantityProrationInvoice",
  {
    target: AccountId,
    input: {
      prorationId: Schema.String,
      invoiceId: Schema.String,
      amount: Schema.Int,
      currency: Schema.String,
    },
    events: [QuantityProrationInvoiced],
    rejects: [NoQuantityProrationDue],
  },
) {}
