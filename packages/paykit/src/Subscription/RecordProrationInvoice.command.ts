import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Proration } from "../Proration.ts";
import { AccountId } from "./Subscription.id.ts";

/** There is no unbilled tier change to charge, or this one already was. */
export class NoProrationDue extends Domain.Rejection("NoProrationDue", {
  account: Schema.String,
  /** `none` when no tier change moved money, `billed` when it already did. */
  reason: Schema.Literals(["none", "billed"]),
}) {}

/**
 * The invoice does not settle the change the standing currently owes. An
 * invoice is evidence of a charge, so its identity and its money have to match
 * the change they name: a stale id belongs to a change a later tier move
 * replaced, and a different amount or currency is not the money that moved.
 */
export class ProrationInvoiceMismatch extends Domain.Rejection("ProrationInvoiceMismatch", {
  account: Schema.String,
  /** The change the standing currently owes. */
  expectedId: Schema.String,
  expected: Proration,
  /** What the caller asked to settle. */
  requestedId: Schema.String,
  requestedAmount: Schema.Int,
  requestedCurrency: Schema.String,
}) {}

/** The proration a tier change moved was billed on a provider invoice. */
export class ProrationInvoiced extends Domain.Event("ProrationInvoiced", {
  /** The change this invoice settles. */
  prorationId: Schema.String,
  invoiceId: Schema.String,
  amount: Schema.Int,
  currency: Schema.String,
}) {}

/**
 * Record the invoice a positive proration was billed on.
 *
 * It is a command rather than a state write because the log must carry the
 * money that moved: an upgrade whose invoice is only on the provider is a
 * charge nobody can audit from paykit's own events. The invoice names the
 * change it settles, so a retry that races a later tier change is refused
 * instead of marking the wrong change paid.
 */
export class RecordProrationInvoice extends Domain.Command("RecordProrationInvoice", {
  target: AccountId,
  input: {
    /** The id `PlanChanged` gave the proration this invoice settles. */
    prorationId: Schema.String,
    invoiceId: Schema.String,
    amount: Schema.Int,
    currency: Schema.String,
  },
  events: [ProrationInvoiced],
  rejects: [NoProrationDue, ProrationInvoiceMismatch],
}) {}
