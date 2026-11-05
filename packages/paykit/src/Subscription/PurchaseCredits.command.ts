import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { CreditRateCards } from "../Feature.ts";
import { Price } from "../Tier.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * A one-off pack was paid for and its credits joined the pool. The amount is
 * credits, not money; `price` is what the buyer was charged, copied from the
 * catalog so a replay can answer it without today's catalog.
 */
export class CreditsPurchased extends Domain.Event("CreditsPurchased", {
  /** The one-off tier that was bought. */
  tier: Schema.String,
  /** The credits the pack grants. */
  amount: Schema.Int,
  /** What the pack cost. Absent when the provider did not report it. */
  price: Schema.optionalKey(Price),
  /**
   * The catalog's rate cards, captured so a credits-only account can price
   * `check()` and `track()` before it has a plan.
   */
  rates: Schema.optionalKey(CreditRateCards),
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
 * a second pack.
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
    /** The catalog's rate cards, so the pool is spendable without a plan. */
    rates: Schema.optionalKey(CreditRateCards),
  },
  events: [CreditsPurchased],
  rejects: [],
  middleware: [Admin],
}) {}
