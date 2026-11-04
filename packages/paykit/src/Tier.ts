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

/**
 * A purchasable bundle: an id, what it grants, and optionally what it costs.
 * The catalog never carries provider ids, so the same tier runs on every
 * provider.
 */
export const Tier = Schema.Struct({
  id: TierId,
  name: Schema.optionalKey(Schema.String),
  price: Schema.optionalKey(Price),
  grants: Schema.Array(Allowance),
});
export type Tier = typeof Tier.Type;

/** A tier as an author writes it. */
export interface TierInput {
  readonly id: string;
  /** Human-facing label for pricing pages and the console. */
  readonly name?: string;
  /** Omit for a free tier. */
  readonly price?: Price;
  /** What the tier grants. A tier that grants nothing could never activate. */
  readonly grants: readonly [Allowance, ...Allowance[]];
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
 * ```
 */
export const tier = (input: TierInput): Tier => ({
  id: input.id as TierId,
  ...(input.name === undefined ? {} : { name: input.name }),
  ...(input.price === undefined ? {} : { price: { ...input.price } }),
  grants: input.grants.map((grant) => ({ ...grant })),
});
