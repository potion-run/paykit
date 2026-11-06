import * as Schema from "effect/Schema";
import { Allowance } from "./Allowance.ts";

/** A tier's stable id: `free`, `pro`, `scale`. */
export const TierId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("TierId"),
);
export type TierId = typeof TierId.Type;

/** The billing cadence a tier is sold on. */
export const Interval = Schema.Literals(["month", "annual"]);
export type Interval = typeof Interval.Type;

/** Money is integer minor units plus a currency. No floats, no dollars. */
export const Price = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  interval: Interval,
});
export type Price = typeof Price.Type;

/** When the credits a tier grants run out. `"period"` zeroes them at a close. */
export const CreditsExpire = Schema.Literals(["period", "never"]);
export type CreditsExpire = typeof CreditsExpire.Type;

/**
 * Credits at or below which a spend buys the deployment's auto top-up pack.
 * It is a line on the tier, not a price: the pack is the product, and this is
 * when a plan's pool should be refilled.
 */
export const TopUpThreshold = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
export type TopUpThreshold = typeof TopUpThreshold.Type;

/**
 * How a tier is bought: a subscription opens a period, while a one-off pack is
 * a single payment that grants credits and never starts a period.
 */
export const TierKind = Schema.Literals(["subscription", "one_off"]);
export type TierKind = typeof TierKind.Type;

/**
 * A purchasable bundle: an id, what it grants, and optionally what it costs.
 * The catalog never carries provider ids, so the same tier runs on every
 * provider.
 */
export const Tier = Schema.Struct({
  id: TierId,
  name: Schema.optionalKey(Schema.String),
  /** @default "subscription" */
  kind: Schema.optionalKey(TierKind),
  price: Schema.optionalKey(Price),
  /** The credit pool this tier grants when it activates or is bought. */
  credits: Schema.optionalKey(Schema.Int),
  /** @default "period" for a subscription, "never" for a one-off pack */
  creditsExpire: Schema.optionalKey(CreditsExpire),
  /**
   * Credits at or below which a spend buys the deployment's auto top-up pack.
   * Absent means this tier never refills; a one-off pack cannot state one.
   */
  topUp: Schema.optionalKey(TopUpThreshold),
  grants: Schema.Array(Allowance),
});
export type Tier = typeof Tier.Type;

/** A subscription tier as an author writes it: at least one grant. */
export interface SubscriptionTierInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  /** @default "subscription" */
  readonly kind?: "subscription";
  /** Omit for a free subscription tier. */
  readonly price?: Price;
  /** The credit pool this tier grants when it activates. */
  readonly credits?: number;
  /** @default "period" */
  readonly creditsExpire?: CreditsExpire;
  /**
   * Credits at or below which a spend buys the deployment's auto top-up pack.
   * Absent means this tier never refills.
   */
  readonly topUp?: number;
  /**
   * What the tier grants. A subscription that grants nothing could never
   * activate, so the tuple requires at least one allowance.
   */
  readonly grants: readonly [Allowance, ...Allowance[]];
}

/** A one-off credit pack as an author writes it: a price, credits, no grants. */
export interface OneOffTierInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  readonly kind: "one_off";
  /** A pack is bought, so it must state a price. */
  readonly price: Price;
  /** The credits the buyer gets. */
  readonly credits: number;
  /** A pack outlives any plan, so its credits never expire. */
  readonly creditsExpire?: "never";
  /** A pack has no standing, so it cannot state a top-up line. */
  readonly topUp?: never;
  /** A pack sells credits, not a standing, so it grants no allowance. */
  readonly grants?: readonly [];
}

/** A tier as an author writes it. */
export type TierInput = SubscriptionTierInput | OneOffTierInput;

/**
 * Declare a purchasable bundle. The catalog validates it; this stays pure.
 *
 * ### Declaring a tier
 * **Example:** A free tier and a tier sold monthly
 * ```typescript
 * const free = tier({
 *   id: "free",
 *   name: "Free",
 *   grants: [allowance(messages, { included: 100 })],
 * });
 *
 * const pro = tier({
 *   id: "pro",
 *   name: "Pro",
 *   price: { amount: 1900, currency: "usd", interval: "month" },
 *   grants: [allowance(messages, { included: 2_000, overage: "bill" })],
 * });
 *
 * // A one-off pack sells credits, not a period.
 * const pack = tier({
 *   id: "credits_1m",
 *   kind: "one_off",
 *   price: { amount: 9_900, currency: "usd", interval: "month" },
 *   credits: 1_000_000,
 *   grants: [],
 * });
 * ```
 */
export const tier = (input: TierInput): Tier => {
  const kind = input.kind ?? "subscription";
  // A one-off pack's credits are what the buyer bought; they must outlive any
  // plan the account happens to be on, so the default is the same `"never"`
  // the catalog requires.
  const creditsExpire = input.creditsExpire ?? (kind === "one_off" ? "never" : undefined);
  const grants = input.grants ?? [];
  return {
    id: input.id as TierId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.kind === undefined ? {} : { kind }),
    ...(input.price === undefined ? {} : { price: { ...input.price } }),
    ...(input.credits === undefined ? {} : { credits: input.credits }),
    ...(creditsExpire === undefined ? {} : { creditsExpire }),
    ...(input.topUp === undefined ? {} : { topUp: input.topUp }),
    grants: grants.map((grant) => ({ ...grant })),
  };
};
