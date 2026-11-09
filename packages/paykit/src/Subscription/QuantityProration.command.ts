import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Proration } from "../Proration.ts";
import { AccountId } from "./Subscription.id.ts";

/** There is no unbilled quantity change to charge, or this one already was. */
export class NoQuantityProrationDue extends Domain.Rejection("NoQuantityProrationDue", {
  account: Schema.String,
  prorationId: Schema.String,
  /** `none` when no quantity change moved money, `billed` when it already did. */
  reason: Schema.Literals(["none", "billed"]),
}) {}

/**
 * The quantity change did not move positive money, so there is nothing to
 * invoice. A reduction is a credit; the standing records it for audit, and
 * paying it out is a refund rather than a subscription charge.
 */
export class QuantityProrationNotBillable extends Domain.Rejection("QuantityProrationNotBillable", {
  account: Schema.String,
  prorationId: Schema.String,
  /** The change's `due`; at or below zero is the reason it cannot be billed. */
  due: Schema.Int,
}) {}

/** The invoice's amount or currency is not the money the change moved. */
export class QuantityProrationMismatch extends Domain.Rejection("QuantityProrationMismatch", {
  account: Schema.String,
  prorationId: Schema.String,
  /** What the standing recorded for this change. */
  expected: Proration,
  /** What the caller asked to settle. */
  requestedAmount: Schema.Int,
  requestedCurrency: Schema.String,
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
 * The invoice settles exactly the change it names: a credit is never billed,
 * and the amount and currency are the ones `SetQuantity` recorded.
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
    rejects: [NoQuantityProrationDue, QuantityProrationNotBillable, QuantityProrationMismatch],
  },
) {}
