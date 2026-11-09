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
 * invoice or apply a credit to. A reduction is a credit; it is spent against a
 * later charge, never paid out (ADR 0042).
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

/** One credit a later quantity charge consumed, and how much of it. */
export const QuantityCreditUse = Schema.Struct({
  /** The change that recorded the credit, by its `dedupeKey`. */
  prorationId: Schema.String,
  /** How much of that credit this charge consumed, in minor units. */
  amount: Schema.Int,
});

/**
 * A quantity charge consumed credits the account held. The event names every
 * credit it spent, oldest first, so the log explains the net `due` without
 * folding the whole history of quantity changes (ADR 0042).
 */
export class QuantityCreditApplied extends Domain.Event("QuantityCreditApplied", {
  /** The change whose charge the credit reduced. */
  prorationId: Schema.String,
  feature: Schema.String,
  /** The credits consumed, oldest first. */
  credits: Schema.Array(QuantityCreditUse),
  /** The total consumed; `charge - amount == dueAfter`. */
  amount: Schema.Int,
  currency: Schema.String,
  /** What the change owed before the credit. */
  charge: Schema.Int,
  /** What it owes after it. Never negative, so no credit is paid out. */
  dueAfter: Schema.Int,
}) {}

/**
 * Spend the credits the account holds against a pending quantity charge.
 *
 * A reduction records a negative `due`; this is the step that spends it
 * against the next charge in the same currency. The application is capped by
 * the charge, so a credit larger than the charge leaves a remainder for a
 * later one, and a charge never goes below zero. `ChargeQuantityProration`
 * applies it before it opens the invoice; a vendor that opens its own invoice
 * is the authority for that invoice, so the credit stays for a later paykit
 * bill (ADR 0042).
 */
export class ApplyQuantityCredit extends Domain.Command("ApplyQuantityCredit", {
  target: AccountId,
  input: { prorationId: Schema.String },
  events: [QuantityCreditApplied],
  rejects: [NoQuantityProrationDue, QuantityProrationNotBillable],
}) {}

/**
 * Record the invoice a positive quantity proration was billed on. Like a tier
 * change's invoice, it is a command so the log carries the money that moved.
 * The invoice settles exactly the change it names after any credit was applied:
 * a credit is never billed, and the amount and currency are the ones the
 * standing now owes.
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
