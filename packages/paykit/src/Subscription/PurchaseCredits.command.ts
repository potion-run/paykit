import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { CreditRateCards } from "../Feature.ts";
import { Price } from "../Tier.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * A one-off pack was bought and its credits joined the pool. The amount is
 * credits, not money; `price` is what the buyer was charged (or owed, when an
 * auto top-up invoiced it), copied from the catalog so a replay can answer it
 * without today's catalog.
 */
export class CreditsPurchased extends Domain.Event("CreditsPurchased", {
  /** The one-off tier that was bought. */
  tier: Schema.String,
  /** The credits the pack grants. */
  amount: Schema.Int,
  /** What the pack cost. Absent when the provider did not report it. */
  price: Schema.optionalKey(Price),
  /**
   * The provider invoice this pack is billed on, when paykit opened one itself
   * rather than waiting for a checkout. It is what marks an automatic top-up
   * in the log; a purchase a webhook reported has no such invoice.
   */
  invoiceId: Schema.optionalKey(Schema.String),
  /**
   * The provider charge that paid for this pack, when the provider took the
   * amount from the customer's saved method instead of invoicing it. Exactly
   * one of `invoiceId` and `chargeId` is set on a purchase paykit opened.
   */
  chargeId: Schema.optionalKey(Schema.String),
  /**
   * The catalog's rate cards, captured so a credits-only account can price
   * `check()` and `track()` before it has a plan.
   */
  rates: Schema.optionalKey(CreditRateCards),
  /**
   * When this top-up's cooldown ends, for a purchase a policy opened. Absent on
   * a checkout's purchase and on a deployment that set no cooldown, so the field
   * is evidence of a deployment decision rather than a standing rule.
   */
  cooldownUntil: Schema.optionalKey(Schema.DateTimeUtc),
  /** The pool after the purchase. */
  balanceAfter: Schema.Int,
  /** The part of the pool a one-off pack bought, and so never expires. */
  prepaidAfter: Schema.Int,
}) {}

/**
 * Add the credits a one-off pack bought. This is the purchase path, not a tier
 * change: the account keeps its standing (or starts with a pool before one
 * exists), and only the never-expiring part of the pool grows. The provider's
 * event id is the command id, so a redelivered payment is a replay rather than
 * a second pack. An auto top-up sends the same command under the crossing's
 * id with the `invoiceId` its policy opened, so a purchase the deployment
 * started is the same record as one a buyer completed.
 */
export class PurchaseCredits extends Domain.Command("PurchaseCredits", {
  target: AccountId,
  input: {
    /** The one-off tier being paid for, kept as evidence in the log. */
    tier: Schema.String,
    /** Credits to grant: the catalog's `credits` for that tier. */
    amount: Schema.Int,
    /** What the buyer was charged, when the provider reported it. */
    price: Schema.optionalKey(Price),
    /**
     * The invoice a top-up opened for this pack. Omitted on the webhook path,
     * where the vendor's payment is the record and no invoice id is known, and
     * on the charged path, which carries `chargeId` instead.
     */
    invoiceId: Schema.optionalKey(Schema.String),
    /**
     * The charge a top-up took from the customer's saved method. Present when
     * the provider declared `charge` and the charge succeeded; the invoice is
     * the fallback, never both.
     */
    chargeId: Schema.optionalKey(Schema.String),
    /** The catalog's rate cards, so the pool is spendable without a plan. */
    rates: Schema.optionalKey(CreditRateCards),
    /**
     * When the auto top-up cooldown this purchase opens ends. The policy sets
     * it from the deployment's `cooldown`; a webhook purchase omits it.
     */
    cooldownUntil: Schema.optionalKey(Schema.DateTimeUtc),
  },
  events: [CreditsPurchased],
  rejects: [],
  middleware: [Admin],
}) {}
