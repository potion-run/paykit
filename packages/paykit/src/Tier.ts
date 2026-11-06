import * as Schema from "effect/Schema";
import { Allowance } from "./Allowance.ts";
import { RateCard } from "./Feature.ts";

/** A tier's stable id: `free`, `pro`, `scale`. */
export const TierId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("TierId"),
);
export type TierId = typeof TierId.Type;

/** The billing cadence a tier is sold on. */
export const Interval = Schema.Literals(["month", "annual"]);
export type Interval = typeof Interval.Type;

/** One currency's amount for a price, alongside the base currency. */
export const AdditionalCurrency = Schema.Struct({
  currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});
export type AdditionalCurrency = typeof AdditionalCurrency.Type;

/** Money is integer minor units plus a currency. No floats, no dollars. */
export const Price = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  interval: Interval,
  /**
   * The same plan sold in other currencies, each amount stated explicitly.
   * No exchange rate is applied: a catalog that wants to sell in EUR says so.
   */
  additionalCurrencies: Schema.optionalKey(Schema.Array(AdditionalCurrency)),
});
export type Price = typeof Price.Type;

/**
 * A price in the currency a caller asks for, or `null` when the tier does not
 * sell in it. The base currency is always available; an additional one only
 * when the catalog states it.
 */
export const priceFor = (price: Price, currency: string): Price | null => {
  if (price.currency === currency) {
    return { amount: price.amount, currency: price.currency, interval: price.interval };
  }
  const additional = price.additionalCurrencies?.find((entry) => entry.currency === currency);
  return additional === undefined
    ? null
    : { amount: additional.amount, currency: additional.currency, interval: price.interval };
};

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

/** What a variant may change about its base tier. */
export const TierCustomize = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  price: Schema.optionalKey(Price),
  credits: Schema.optionalKey(Schema.Int),
  creditsExpire: Schema.optionalKey(CreditsExpire),
  topUp: Schema.optionalKey(TopUpThreshold),
  grants: Schema.optionalKey(Schema.Array(Allowance)),
  rateCard: Schema.optionalKey(Schema.Record(Schema.String, RateCard)),
});
export type TierCustomize = typeof TierCustomize.Type;

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
  /**
   * The base tier this one is a named alternative of, e.g. annual Pro. The
   * catalog resolves the variant into a full tier, so the runtime never sees
   * a partial one.
   */
  variantOf: Schema.optionalKey(TierId),
  /** What this variant changes about its base. Requires `variantOf`. */
  customize: Schema.optionalKey(TierCustomize),
  /**
   * Per-feature rate-card overrides for this tier. A feature with no entry
   * uses the card the catalog declares for it.
   */
  rateCard: Schema.optionalKey(Schema.Record(Schema.String, RateCard)),
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
  /** The base tier this one is a named alternative of. */
  readonly variantOf?: string;
  /** What this variant changes about its base. Requires `variantOf`. */
  readonly customize?: TierCustomize;
  /** Per-feature rate-card overrides for this tier. */
  readonly rateCard?: Readonly<Record<string, RateCard>>;
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
  readonly variantOf?: never;
  readonly customize?: never;
  readonly rateCard?: never;
}

/**
 * A variant as an author writes it: the fields it changes, over a base tier.
 * `grants` may be omitted, because the base's grants are inherited.
 */
export interface VariantTierInput {
  readonly id: string;
  readonly name?: string;
  readonly kind?: "subscription";
  readonly price?: Price;
  readonly credits?: number;
  readonly creditsExpire?: CreditsExpire;
  readonly topUp?: number;
  readonly grants?: readonly Allowance[];
  readonly variantOf: string;
  readonly customize?: TierCustomize;
  readonly rateCard?: Readonly<Record<string, RateCard>>;
}

/** A tier as an author writes it. */
export type TierInput = SubscriptionTierInput | VariantTierInput | OneOffTierInput;

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
    ...(input.variantOf === undefined ? {} : { variantOf: input.variantOf as TierId }),
    ...(input.customize === undefined ? {} : { customize: input.customize }),
    ...(input.rateCard === undefined ? {} : { rateCard: { ...input.rateCard } }),
    grants: grants.map((grant) => ({ ...grant })),
  };
};
