import * as Schema from "effect/Schema";
import { Allowances } from "../Allowance.ts";
import { CreditRateCards } from "../Feature.ts";
import { CreditsExpire, PlanVersion, Price, TopUpTerms } from "../Tier.ts";

/**
 * The terms a hosted purchase quoted, held until the provider's completion
 * records them. A checkout names the plan, not the negotiated allowances, so
 * the quote has to be stored before the provider is asked and read back by the
 * webhook that activates it (ADR 0042 §1).
 *
 * It is the `Subscribe` command's catalog-derived input plus the period anchor:
 * exactly what an activation needs, and nothing the provider's reference could
 * derive for itself. The bespoke allowances are here for a custom plan, and the
 * price is here for one bought at a negotiated price.
 */
export const PendingActivation = Schema.Struct({
  /** The plan the checkout was opened for. */
  tier: Schema.String,
  /** The catalog generation the checkout quoted (ADR 0047). */
  version: Schema.optionalKey(PlanVersion),
  /** The group the plan fills; absent means the default group. */
  group: Schema.optionalKey(Schema.String),
  /** Whether the plan stacks beside every group instead of filling one. */
  addOn: Schema.optionalKey(Schema.Boolean),
  /** The sold items, bespoke or the catalog's defaults. */
  allowances: Allowances,
  /** What the account was quoted. Absent on a free plan. */
  price: Schema.optionalKey(Price),
  /** The credits the plan grants on activation. */
  credits: Schema.Int,
  /** Whether that pool expires at a period close. */
  creditsExpire: CreditsExpire,
  /** Credits at or below which a spend buys the deployment's auto top-up pack. */
  topUp: Schema.optionalKey(TopUpTerms),
  /** Every credit-priced feature's rate card, as the plan states it. */
  rates: CreditRateCards,
  /** The period anchor the checkout stated; absent means UTC. */
  anchorTz: Schema.optionalKey(Schema.String),
});

export type PendingActivation = typeof PendingActivation.Type;

/**
 * A completion arrived for a custom plan whose quoted terms are not on the
 * account. The activation cannot fall back to the catalog: its defaults are a
 * different deal at the same price (ADR 0042 §1).
 */
export class PendingActivationMissing extends Schema.TaggedError<PendingActivationMissing>()(
  "PendingActivationMissing",
  {
    account: Schema.String,
    tier: Schema.String,
  },
) {}

/**
 * A completion arrived for a plan other than the one the stored quote names.
 * The quote belongs to another purchase, so activating it would contract for
 * terms nobody bought.
 */
export class PendingActivationStale extends Schema.TaggedError<PendingActivationStale>()(
  "PendingActivationStale",
  {
    account: Schema.String,
    tier: Schema.String,
    pendingTier: Schema.String,
  },
) {}

/** Every refusal a completion can answer about the quote it found. */
export type PendingActivationRefusal = PendingActivationMissing | PendingActivationStale;
