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

/** A tier as an author writes it. */
export interface TierInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  /** @default "subscription" */
  readonly kind?: TierKind;
  /** Omit for a free subscription tier. A one-off pack must state one. */
  readonly price?: Price;
  /** The credit pool this tier grants when it activates or is bought. */
  readonly credits?: number;
  /** @default "period" for a subscription, "never" for a one-off pack */
  readonly creditsExpire?: CreditsExpire;
  /**
   * Credits at or below which a spend buys the deployment's auto top-up pack.
   * Absent means this tier never refills; a one-off pack cannot state one.
   */
  readonly topUp?: number;
  /**
   * What a subscription tier grants. Empty for a one-off pack, which sells only
   * credits; the catalog refuses either shape the wrong way round.
   */
  readonly grants: readonly Allowance[];
}

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
  return {
    id: input.id as TierId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.kind === undefined ? {} : { kind }),
    ...(input.price === undefined ? {} : { price: { ...input.price } }),
    ...(input.credits === undefined ? {} : { credits: input.credits }),
    ...(creditsExpire === undefined ? {} : { creditsExpire }),
    ...(input.topUp === undefined ? {} : { topUp: input.topUp }),
    grants: input.grants.map((grant) => ({ ...grant })),
  };
};
