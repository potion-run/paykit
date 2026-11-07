import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  Allowances,
  isFlagGrant,
  isQuantityGrant,
  pricingOf,
  type Allowance,
} from "./Allowance.ts";
import { CreditRateCards, Feature, RateCard, cardFromRates } from "./Feature.ts";
import { currencyOfPricing, unitsOf, type Pricing } from "./Pricing.ts";
import { CreditsExpire, Price, Tier, priceFor, type TierKind, type TopUpTerms } from "./Tier.ts";

/**
 * The deploy-time catalog: every declared feature and every purchasable tier.
 * It is plain data, so it serializes into stack state and a runtime layer
 * without functions hiding in it. It is not an Alchemy `Resource` on purpose:
 * `BillingStack` is the resource, and the catalog is its validated desired
 * state.
 */
export const Catalog = Schema.Struct({
  features: Schema.Array(Feature),
  tiers: Schema.Array(Tier),
});
export type Catalog = typeof Catalog.Type;

/** A catalog as an author writes it. */
export interface CatalogInput {
  readonly features: ReadonlyArray<Feature>;
  readonly tiers: ReadonlyArray<Tier>;
}

/** The same feature id was declared twice. */
export class CatalogDuplicateFeature extends Schema.TaggedError<CatalogDuplicateFeature>()(
  "CatalogDuplicateFeature",
  { feature: Schema.String },
) {}

/** The same tier id was declared twice. */
export class CatalogDuplicateTier extends Schema.TaggedError<CatalogDuplicateTier>()(
  "CatalogDuplicateTier",
  { tier: Schema.String },
) {}

/** A tier quotes the same feature twice. */
export class CatalogDuplicateAllowance extends Schema.TaggedError<CatalogDuplicateAllowance>()(
  "CatalogDuplicateAllowance",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A tier grants a feature the catalog never declared. */
export class CatalogUnknownFeature extends Schema.TaggedError<CatalogUnknownFeature>()(
  "CatalogUnknownFeature",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A tier with no grants could never activate, so it is refused at deploy. */
export class CatalogEmptyTier extends Schema.TaggedError<CatalogEmptyTier>()("CatalogEmptyTier", {
  tier: Schema.String,
}) {}

/**
 * An unlimited allowance names an overage. Past an allowance that never runs
 * out there is nothing to block and nothing to bill, so `block` or `bill`
 * beside `included: "unlimited"` is a contradiction the deploy refuses rather
 * than a rule `decide` has to interpret.
 */
export class CatalogUnlimitedOverage extends Schema.TaggedError<CatalogUnlimitedOverage>()(
  "CatalogUnlimitedOverage",
  { tier: Schema.String, feature: Schema.String },
) {}

/**
 * A flag was granted with a count. A `kind: "flag"` feature is on or off, so
 * its allowance is `included: 1` with `overage: "allow"` and `resets: "never"`
 * — the shape `grant()` writes. Anything else describes a counter that does
 * not exist, so the deploy refuses it rather than leaving `decide` to
 * interpret it.
 */
export class CatalogFlagNotGranted extends Schema.TaggedError<CatalogFlagNotGranted>()(
  "CatalogFlagNotGranted",
  { tier: Schema.String, feature: Schema.String },
) {}

/**
 * A metered feature was granted with `grant()`. A flag grant is "granted, not
 * counted"; beside a feature that is counted it would silently stop recording
 * usage, so the deploy refuses it.
 */
export class CatalogFlagOnMetered extends Schema.TaggedError<CatalogFlagOnMetered>()(
  "CatalogFlagOnMetered",
  { tier: Schema.String, feature: Schema.String },
) {}

/**
 * A flag was told to carry its unspent allowance. A flag has no counter, so
 * there is nothing to carry: the setting would be a silent no-op.
 */
export class CatalogCarryOverOnFlag extends Schema.TaggedError<CatalogCarryOverOnFlag>()(
  "CatalogCarryOverOnFlag",
  { tier: Schema.String, feature: Schema.String },
) {}

/**
 * `carryOver` on an allowance that never resets. There is no boundary for the
 * carry to happen at, so the setting would be a silent no-op; the deploy
 * refuses it instead of recording a field that does nothing.
 */
export class CatalogCarryOverNeverResets extends Schema.TaggedError<CatalogCarryOverNeverResets>()(
  "CatalogCarryOverNeverResets",
  { tier: Schema.String, feature: Schema.String },
) {}

/**
 * A credit-priced feature has no rate for the default dimension. Every rate
 * card needs a `"default"`, or a caller that names no dimension cannot be
 * priced at all.
 */
export class CatalogCreditRateMissing extends Schema.TaggedError<CatalogCreditRateMissing>()(
  "CatalogCreditRateMissing",
  { feature: Schema.String },
) {}

/** A rate that is not a positive integer of credits per unit. */
export class CatalogCreditRateInvalid extends Schema.TaggedError<CatalogCreditRateInvalid>()(
  "CatalogCreditRateInvalid",
  { feature: Schema.String, dimension: Schema.String },
) {}

/**
 * A tier grants an allowance for a feature priced in credits. A pool and a
 * counter cannot both be the answer to "how much is left", so the allowance is
 * refused rather than silently shadowed.
 */
export class CatalogCreditFeatureHasAllowance extends Schema.TaggedError<CatalogCreditFeatureHasAllowance>()(
  "CatalogCreditFeatureHasAllowance",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A `kind: "flag"` feature declared a rate card. A flag has nothing to spend. */
export class CatalogCreditRatesOnFlag extends Schema.TaggedError<CatalogCreditRatesOnFlag>()(
  "CatalogCreditRatesOnFlag",
  { feature: Schema.String },
) {}

/**
 * A tier states an impossible credit grant: a negative pool, or an expiry for
 * credits it never grants.
 */
export class CatalogCreditGrantInvalid extends Schema.TaggedError<CatalogCreditGrantInvalid>()(
  "CatalogCreditGrantInvalid",
  { tier: Schema.String },
) {}

/**
 * A cap was stated where nothing is billed. On `"block"` an allowance already
 * stops at `included`, and on `"allow"` past it is never billed, so a cap would
 * be a number with no effect — including beside `"unlimited"`, which defaults
 * to `"allow"`.
 */
export class CatalogCapWithoutBilling extends Schema.TaggedError<CatalogCapWithoutBilling>()(
  "CatalogCapWithoutBilling",
  { tier: Schema.String, feature: Schema.String },
) {}

/**
 * A one-off tier grants a feature. A pack sells credits, not a standing, so the
 * allowance would describe an entitlement nothing activates.
 */
export class CatalogOneOffGrant extends Schema.TaggedError<CatalogOneOffGrant>()(
  "CatalogOneOffGrant",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A one-off tier that sells no credits, or a negative number of them. */
export class CatalogOneOffCredits extends Schema.TaggedError<CatalogOneOffCredits>()(
  "CatalogOneOffCredits",
  { tier: Schema.String },
) {}

/**
 * A one-off tier's credits expire at a period close. A pack is bought ahead of
 * any period, so a close must not wipe it.
 */
export class CatalogOneOffCreditsExpire extends Schema.TaggedError<CatalogOneOffCreditsExpire>()(
  "CatalogOneOffCreditsExpire",
  { tier: Schema.String },
) {}

/** A one-off tier with no price could not be bought. */
export class CatalogOneOffWithoutPrice extends Schema.TaggedError<CatalogOneOffWithoutPrice>()(
  "CatalogOneOffWithoutPrice",
  { tier: Schema.String },
) {}

/**
 * A one-off pack states a top-up threshold. A pack has no standing, so there is
 * no spend for the threshold to observe; the field would never be read.
 */
export class CatalogTopUpOnPack extends Schema.TaggedError<CatalogTopUpOnPack>()(
  "CatalogTopUpOnPack",
  { tier: Schema.String },
) {}

/**
 * A tier's top-up line names a pack the catalog does not sell. It is a refusal
 * rather than a deferred failure because the deploy is the last place the name
 * can be checked against the catalog it came from.
 */
export class CatalogUnknownTopUpPack extends Schema.TaggedError<CatalogUnknownTopUpPack>()(
  "CatalogUnknownTopUpPack",
  { tier: Schema.String, pack: Schema.String },
) {}

/** A unit price where nothing is billed. A unit price only prices an overage. */
export class CatalogUnitPriceWithoutBilling extends Schema.TaggedError<CatalogUnitPriceWithoutBilling>()(
  "CatalogUnitPriceWithoutBilling",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A money cap without a unit price. A ceiling in money needs a price to count it. */
export class CatalogMoneyCapWithoutUnitPrice extends Schema.TaggedError<CatalogMoneyCapWithoutUnitPrice>()(
  "CatalogMoneyCapWithoutUnitPrice",
  { tier: Schema.String, feature: Schema.String },
) {}

/**
 * A tier's postpaid prices do not agree on a currency, or disagree with the
 * tier's own price. One standing has one currency, so the bill cannot mix.
 */
export class CatalogUnitPriceCurrency extends Schema.TaggedError<CatalogUnitPriceCurrency>()(
  "CatalogUnitPriceCurrency",
  { tier: Schema.String, currency: Schema.String },
) {}

/** A price was stated where nothing is billed: only `overage: "bill"` prices units. */
export class CatalogPricingWithoutBilling extends Schema.TaggedError<CatalogPricingWithoutBilling>()(
  "CatalogPricingWithoutBilling",
  { tier: Schema.String, feature: Schema.String },
) {}

/** An allowance stated both a one-rate price and a banded pricing. */
export class CatalogPricingConflict extends Schema.TaggedError<CatalogPricingConflict>()(
  "CatalogPricingConflict",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A banded pricing's bands are empty, out of order, or do not end at `"inf"`. */
export class CatalogPricingBand extends Schema.TaggedError<CatalogPricingBand>()(
  "CatalogPricingBand",
  { tier: Schema.String, feature: Schema.String, band: Schema.String },
) {}

/** A banded pricing's rates rise as volume grows, so a volume price is not a discount. */
export class CatalogVolumeRateRises extends Schema.TaggedError<CatalogVolumeRateRises>()(
  "CatalogVolumeRateRises",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A pricing bills in a currency the tier's price does not. */
export class CatalogPricingCurrency extends Schema.TaggedError<CatalogPricingCurrency>()(
  "CatalogPricingCurrency",
  { tier: Schema.String, currency: Schema.String },
) {}

/** A feature declared both a rate map and a rate card. */
export class CatalogRateCardConflict extends Schema.TaggedError<CatalogRateCardConflict>()(
  "CatalogRateCardConflict",
  { feature: Schema.String },
) {}

/** A rate card on a flag, which has nothing to spend. */
export class CatalogRateCardOnFlag extends Schema.TaggedError<CatalogRateCardOnFlag>()(
  "CatalogRateCardOnFlag",
  { feature: Schema.String },
) {}

/** A tier overrides a feature's rate card, but the feature is not credit-priced. */
export class CatalogRateCardOverride extends Schema.TaggedError<CatalogRateCardOverride>()(
  "CatalogRateCardOverride",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A rate card states a rate that is not a positive integer. */
export class CatalogRateInvalid extends Schema.TaggedError<CatalogRateInvalid>()(
  "CatalogRateInvalid",
  { feature: Schema.String, dimension: Schema.String },
) {}

/** A carry cap or window was stated without `carryOver`. */
export class CatalogCarryWithoutCarry extends Schema.TaggedError<CatalogCarryWithoutCarry>()(
  "CatalogCarryWithoutCarry",
  { tier: Schema.String, feature: Schema.String, field: Schema.String },
) {}

/** `resetEvery` beside `resets: "never"`, which has no boundary to count. */
export class CatalogResetEveryNever extends Schema.TaggedError<CatalogResetEveryNever>()(
  "CatalogResetEveryNever",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A variant names a base tier the catalog never declares. */
export class CatalogUnknownVariant extends Schema.TaggedError<CatalogUnknownVariant>()(
  "CatalogUnknownVariant",
  { tier: Schema.String, variantOf: Schema.String },
) {}

/** A variant's base chain returns to itself. */
export class CatalogVariantCycle extends Schema.TaggedError<CatalogVariantCycle>()(
  "CatalogVariantCycle",
  { tier: Schema.String },
) {}

/** A tier states `customize` without naming a base tier. */
export class CatalogCustomizeWithoutVariant extends Schema.TaggedError<CatalogCustomizeWithoutVariant>()(
  "CatalogCustomizeWithoutVariant",
  { tier: Schema.String },
) {}

/** A one-off pack declares a variant; a pack has no base to customize. */
export class CatalogVariantOnPack extends Schema.TaggedError<CatalogVariantOnPack>()(
  "CatalogVariantOnPack",
  { tier: Schema.String },
) {}

/** An additional currency repeats the base currency or another entry. */
export class CatalogAdditionalCurrency extends Schema.TaggedError<CatalogAdditionalCurrency>()(
  "CatalogAdditionalCurrency",
  { tier: Schema.String, currency: Schema.String },
) {}

/** A rate card on a non-consumable feature, which is priced as a quantity. */
export class CatalogRateCardOnQuantity extends Schema.TaggedError<CatalogRateCardOnQuantity>()(
  "CatalogRateCardOnQuantity",
  { feature: Schema.String },
) {}

/** A non-consumable feature granted with a metered or flag allowance, or the reverse. */
export class CatalogQuantityKind extends Schema.TaggedError<CatalogQuantityKind>()(
  "CatalogQuantityKind",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A quantity's included amount must be a count; "unlimited" has no quantity to set. */
export class CatalogQuantityIncluded extends Schema.TaggedError<CatalogQuantityIncluded>()(
  "CatalogQuantityIncluded",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A quantity never resets, so a reset schedule on one is a silent no-op. */
export class CatalogQuantityResets extends Schema.TaggedError<CatalogQuantityResets>()(
  "CatalogQuantityResets",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A field that only a metered allowance uses was stated on a quantity. */
export class CatalogQuantityField extends Schema.TaggedError<CatalogQuantityField>()(
  "CatalogQuantityField",
  { tier: Schema.String, feature: Schema.String, field: Schema.String },
) {}

/** A quantity is priced per seat, not by a graduated or volume ladder. */
export class CatalogQuantityPricing extends Schema.TaggedError<CatalogQuantityPricing>()(
  "CatalogQuantityPricing",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A billable quantity states no price, so additional seats would be free. */
export class CatalogQuantityWithoutPrice extends Schema.TaggedError<CatalogQuantityWithoutPrice>()(
  "CatalogQuantityWithoutPrice",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A quantity cap below the free grant would make the grant unreachable. */
export class CatalogQuantityCap extends Schema.TaggedError<CatalogQuantityCap>()(
  "CatalogQuantityCap",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A proration rule on a metered allowance, which is billed by usage. */
export class CatalogProrateOnMetered extends Schema.TaggedError<CatalogProrateOnMetered>()(
  "CatalogProrateOnMetered",
  { tier: Schema.String, feature: Schema.String },
) {}

/** A value that does not satisfy the catalog schema, with its path in `message`. */
export class CatalogInvalid extends Schema.TaggedError<CatalogInvalid>()("CatalogInvalid", {
  message: Schema.String,
}) {}

/** Every way `catalog()` can refuse, as one tagged union. */
export const CatalogError = Schema.Union([
  CatalogDuplicateFeature,
  CatalogDuplicateTier,
  CatalogDuplicateAllowance,
  CatalogUnknownFeature,
  CatalogEmptyTier,
  CatalogUnlimitedOverage,
  CatalogFlagNotGranted,
  CatalogFlagOnMetered,
  CatalogCarryOverOnFlag,
  CatalogCarryOverNeverResets,
  CatalogCreditRateMissing,
  CatalogCreditRateInvalid,
  CatalogCreditFeatureHasAllowance,
  CatalogCreditRatesOnFlag,
  CatalogCreditGrantInvalid,
  CatalogCapWithoutBilling,
  CatalogOneOffGrant,
  CatalogOneOffCredits,
  CatalogOneOffCreditsExpire,
  CatalogOneOffWithoutPrice,
  CatalogTopUpOnPack,
  CatalogUnknownTopUpPack,
  CatalogUnitPriceWithoutBilling,
  CatalogMoneyCapWithoutUnitPrice,
  CatalogUnitPriceCurrency,
  CatalogPricingWithoutBilling,
  CatalogPricingConflict,
  CatalogPricingBand,
  CatalogVolumeRateRises,
  CatalogPricingCurrency,
  CatalogRateCardConflict,
  CatalogRateCardOnFlag,
  CatalogRateCardOverride,
  CatalogRateInvalid,
  CatalogCarryWithoutCarry,
  CatalogResetEveryNever,
  CatalogUnknownVariant,
  CatalogVariantCycle,
  CatalogCustomizeWithoutVariant,
  CatalogVariantOnPack,
  CatalogAdditionalCurrency,
  CatalogRateCardOnQuantity,
  CatalogQuantityKind,
  CatalogQuantityIncluded,
  CatalogQuantityResets,
  CatalogQuantityField,
  CatalogQuantityPricing,
  CatalogQuantityWithoutPrice,
  CatalogQuantityCap,
  CatalogProrateOnMetered,
  CatalogInvalid,
]);
export type CatalogError = typeof CatalogError.Type;

const duplicateOf = <A>(values: ReadonlyArray<A>, key: (value: A) => string): string | null => {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
};

/**
 * Validate a catalog: the schema first, then the references the schema cannot
 * see — duplicate declarations, a grant with no declared feature, a tier that
 * grants nothing, an unlimited allowance that claims an overage, a flag that
 * was given a count, a carry that cannot happen, a cap where nothing is billed.
 * Provider ids never appear here, so the same catalog runs on every provider.
 *
 * ### Validating a catalog
 * **Example:** A free and a priced tier, both quoting one declared feature
 * ```typescript
 * const messages = feature({ id: "messages", name: "Messages" });
 *
 * const free = tier({
 *   id: "free",
 *   grants: [allowance(messages, { included: 100 })],
 * });
 * const pro = tier({
 *   id: "pro",
 *   price: { amount: 1900, currency: "usd", interval: "month" },
 *   grants: [allowance(messages, { included: 2_000, overage: "bill" })],
 * });
 *
 * const result = defineCatalog({ features: [messages], tiers: [free, pro] });
 * ```
 */
const mergeVariant = (base: Tier, variant: Tier): Tier => {
  const customize = variant.customize ?? {};
  return {
    ...base,
    id: variant.id,
    ...(customize.name !== undefined
      ? { name: customize.name }
      : variant.name !== undefined
        ? { name: variant.name }
        : {}),
    ...(customize.price !== undefined
      ? { price: customize.price }
      : variant.price !== undefined
        ? { price: variant.price }
        : {}),
    ...(customize.credits !== undefined
      ? { credits: customize.credits }
      : variant.credits !== undefined
        ? { credits: variant.credits }
        : {}),
    ...(customize.creditsExpire !== undefined
      ? { creditsExpire: customize.creditsExpire }
      : variant.creditsExpire !== undefined
        ? { creditsExpire: variant.creditsExpire }
        : {}),
    ...(customize.topUp !== undefined
      ? { topUp: customize.topUp }
      : variant.topUp !== undefined
        ? { topUp: variant.topUp }
        : {}),
    ...(customize.rateCard !== undefined
      ? { rateCard: customize.rateCard }
      : variant.rateCard !== undefined
        ? { rateCard: variant.rateCard }
        : {}),
    // `tier()` always writes `grants`; an empty list on a variant means "inherit",
    // because the variant's base is where the author stated them.
    grants: customize.grants ?? (variant.grants.length > 0 ? variant.grants : base.grants),
  };
};

/**
 * Resolve every variant into a full tier. A variant is a named alternative of
 * a base: it inherits every field it does not state, so the runtime and the
 * catalog validation only ever see complete tiers. A cycle and a missing base
 * are refused here rather than left for a consumer to discover.
 */
const resolveVariants = (
  tiers: ReadonlyArray<Tier>,
): Result.Result<ReadonlyArray<Tier>, CatalogError> => {
  const byId = new Map<string, Tier>(tiers.map((tier) => [tier.id, tier]));
  const resolved = new Map<string, Tier>();
  const resolving = new Set<string>();
  const resolve = (id: string): Result.Result<Tier, CatalogError> => {
    const cached = resolved.get(id);
    if (cached !== undefined) return Result.succeed(cached);
    const tier = byId.get(id);
    if (tier === undefined)
      return Result.fail(new CatalogUnknownVariant({ tier: id, variantOf: id }));
    if (tier.variantOf === undefined) {
      resolved.set(id, tier);
      return Result.succeed(tier);
    }
    // A pack has no standing to customize, and a variant is resolved before
    // the one-off checks, so this is the only place the combination is visible.
    if (tier.kind === "one_off") return Result.fail(new CatalogVariantOnPack({ tier: id }));
    if (resolving.has(id)) return Result.fail(new CatalogVariantCycle({ tier: id }));
    resolving.add(id);
    const base = resolve(tier.variantOf);
    resolving.delete(id);
    if (Result.isFailure(base)) return Result.fail(base.failure);
    const merged = mergeVariant(base.success, tier);
    resolved.set(id, merged);
    return Result.succeed(merged);
  };
  for (const tier of tiers) {
    const answer = resolve(tier.id);
    if (Result.isFailure(answer)) return Result.fail(answer.failure);
  }
  return Result.succeed(tiers.map((tier) => resolved.get(tier.id)!));
};

/** The bands of a banded pricing are ordered, end at `inf`, and agree on currency. */
const bandErrorOf = (tier: string, feature: string, pricing: Pricing): CatalogError | null => {
  if (pricing._tag === "unit") return null;
  const bands = pricing.bands;
  let previous = 0;
  for (const [index, band] of bands.entries()) {
    const ceiling = band.upTo;
    if (ceiling !== "inf" && ceiling <= previous) {
      return new CatalogPricingBand({ tier, feature, band: String(ceiling) });
    }
    if (ceiling === "inf" && index !== bands.length - 1) {
      return new CatalogPricingBand({ tier, feature, band: "inf" });
    }
    if (band.unitPrice.currency !== pricing.currency) {
      return new CatalogPricingCurrency({ tier, currency: band.unitPrice.currency });
    }
    if (ceiling !== "inf") previous = ceiling;
  }
  if (bands[bands.length - 1]!.upTo !== "inf") {
    return new CatalogPricingBand({ tier, feature, band: "inf" });
  }
  if (pricing._tag === "volume") {
    // A volume price charges the whole total at one band's rate, so a later
    // band that costs more per unit would make buying more cost more per unit.
    // A volume catalog is a discount ladder; a rising rate is refused.
    let last = Infinity;
    for (const band of bands) {
      const normalized = band.unitPrice.amount / unitsOf(band.unitPrice);
      if (normalized > last) return new CatalogVolumeRateRises({ tier, feature });
      last = normalized;
    }
  }
  return null;
};

/** A pricing only exists where billing does, and its currency is the tier's. */
const pricingErrorOf = (tier: Tier, feature: string, allowance: Allowance): CatalogError | null => {
  const pricing = pricingOf(allowance);
  if (pricing === null) return null;
  if (allowance.pricing !== undefined && allowance.unitPrice !== undefined) {
    return new CatalogPricingConflict({ tier: tier.id, feature });
  }
  if (allowance.overage !== "bill") {
    return allowance.unitPrice !== undefined
      ? new CatalogUnitPriceWithoutBilling({ tier: tier.id, feature })
      : new CatalogPricingWithoutBilling({ tier: tier.id, feature });
  }
  const bands = bandErrorOf(tier.id, feature, pricing);
  if (bands !== null) return bands;
  const currency = currencyOfPricing(pricing);
  if (tier.price !== undefined && currency !== tier.price.currency) {
    return allowance.unitPrice !== undefined
      ? new CatalogUnitPriceCurrency({ tier: tier.id, currency })
      : new CatalogPricingCurrency({ tier: tier.id, currency });
  }
  // A postpaid price is stated in one currency, and a tier sold in several
  // would bill usage in the base one without saying so. Refuse the combination
  // rather than let a EUR customer be metered in USD.
  if (tier.price !== undefined && (tier.price.additionalCurrencies?.length ?? 0) > 0) {
    return new CatalogPricingCurrency({ tier: tier.id, currency });
  }
  return null;
};

const featureCardOf = (feature: Feature): Result.Result<RateCard | null, CatalogError> => {
  if (feature.creditRates !== undefined && feature.rateCard !== undefined) {
    return Result.fail(new CatalogRateCardConflict({ feature: feature.id }));
  }
  if (feature.kind === "flag" && feature.creditRates !== undefined) {
    return Result.fail(new CatalogCreditRatesOnFlag({ feature: feature.id }));
  }
  if (feature.kind === "flag" && feature.rateCard !== undefined) {
    return Result.fail(new CatalogRateCardOnFlag({ feature: feature.id }));
  }
  if (
    feature.kind === "non_consumable" &&
    (feature.creditRates !== undefined || feature.rateCard !== undefined)
  ) {
    return Result.fail(new CatalogRateCardOnQuantity({ feature: feature.id }));
  }
  if (feature.creditRates !== undefined) {
    const rates = feature.creditRates;
    if (!Object.hasOwn(rates, "default")) {
      return Result.fail(new CatalogCreditRateMissing({ feature: feature.id }));
    }
    for (const [dimension, rate] of Object.entries(rates)) {
      if (rate <= 0) {
        return Result.fail(new CatalogCreditRateInvalid({ feature: feature.id, dimension }));
      }
    }
    return Result.succeed(cardFromRates(rates));
  }
  if (feature.rateCard !== undefined) {
    const card = feature.rateCard;
    if (card.default <= 0) {
      return Result.fail(new CatalogRateInvalid({ feature: feature.id, dimension: "default" }));
    }
    for (const [dimension, rate] of Object.entries(card.dimensions ?? {})) {
      if (rate <= 0) {
        return Result.fail(new CatalogRateInvalid({ feature: feature.id, dimension }));
      }
    }
    for (const rule of card.rules ?? []) {
      if (rule.credits <= 0) {
        return Result.fail(
          new CatalogRateInvalid({ feature: feature.id, dimension: JSON.stringify(rule.match) }),
        );
      }
    }
    return Result.succeed(card);
  }
  return Result.succeed(null);
};

/**
 * Validate a catalog: the schema first, then the references the schema cannot
 * see — duplicate declarations, a grant with no declared feature, a tier that
 * grants nothing, an unlimited allowance that claims an overage, a flag that
 * was given a count, a carry that cannot happen, a cap where nothing is billed,
 * bands that do not form a ladder, and a variant whose base does not exist.
 * Provider ids never appear here, so the same catalog runs on every provider.
 *
 * ### Validating a catalog
 * **Example:** A free and a priced tier, both quoting one declared feature
 * ```typescript
 * const messages = feature({ id: "messages", name: "Messages" });
 *
 * const free = tier({
 *   id: "free",
 *   grants: [allowance(messages, { included: 100 })],
 * });
 * const pro = tier({
 *   id: "pro",
 *   price: { amount: 1900, currency: "usd", interval: "month" },
 *   grants: [allowance(messages, { included: 2_000, overage: "bill" })],
 * });
 *
 * const result = defineCatalog({ features: [messages], tiers: [free, pro] });
 * ```
 */
export const defineCatalog = (input: CatalogInput): Result.Result<Catalog, CatalogError> => {
  const decoded = Schema.decodeResult(Catalog)(input);
  if (Result.isFailure(decoded)) {
    return Result.fail(new CatalogInvalid({ message: decoded.failure.message }));
  }
  const variants = resolveVariants(decoded.success.tiers);
  if (Result.isFailure(variants)) return Result.fail(variants.failure);
  const catalog: Catalog = { ...decoded.success, tiers: variants.success };

  const duplicateFeature = duplicateOf(catalog.features, (feature) => feature.id);
  if (duplicateFeature !== null) {
    return Result.fail(new CatalogDuplicateFeature({ feature: duplicateFeature }));
  }

  const duplicateTier = duplicateOf(catalog.tiers, (tier) => tier.id);
  if (duplicateTier !== null) {
    return Result.fail(new CatalogDuplicateTier({ tier: duplicateTier }));
  }

  const declared = new Set(catalog.features.map((feature) => feature.id));
  // The packs an auto top-up line may name: a one-off tier is a pack by
  // definition, and the loop below already requires its credits and its price,
  // so naming one here is enough for the runtime to buy it.
  const packs = new Set(
    catalog.tiers
      .filter((tier) => (tier.kind ?? "subscription") === "one_off")
      .map((tier) => tier.id as string),
  );
  const kinds = new Map(catalog.features.map((feature) => [feature.id, feature.kind]));
  const cards = new Map<string, RateCard>();
  const creditPriced = new Set<string>();
  for (const feature of catalog.features) {
    const card = featureCardOf(feature);
    if (Result.isFailure(card)) return Result.fail(card.failure);
    if (card.success === null) continue;
    cards.set(feature.id, card.success);
    creditPriced.add(feature.id);
  }
  for (const tier of catalog.tiers) {
    const kind = tier.kind ?? "subscription";
    if (tier.customize !== undefined && tier.variantOf === undefined) {
      return Result.fail(new CatalogCustomizeWithoutVariant({ tier: tier.id }));
    }
    if (kind === "one_off" && tier.variantOf !== undefined) {
      return Result.fail(new CatalogVariantOnPack({ tier: tier.id }));
    }
    if (kind === "one_off") {
      // A pack is a price and a number of credits, and nothing else: no
      // allowance (nothing activates), no expiring pool (a close must not wipe
      // it), and a price (otherwise there is no purchase).
      const first = tier.grants[0];
      if (first !== undefined) {
        return Result.fail(new CatalogOneOffGrant({ tier: tier.id, feature: first.feature }));
      }
      if (tier.credits === undefined || tier.credits <= 0) {
        return Result.fail(new CatalogOneOffCredits({ tier: tier.id }));
      }
      if (tier.creditsExpire !== "never") {
        return Result.fail(new CatalogOneOffCreditsExpire({ tier: tier.id }));
      }
      if (tier.price === undefined) {
        return Result.fail(new CatalogOneOffWithoutPrice({ tier: tier.id }));
      }
      if (tier.topUp !== undefined) {
        return Result.fail(new CatalogTopUpOnPack({ tier: tier.id }));
      }
      continue;
    }
    if (
      (tier.credits !== undefined && tier.credits < 0) ||
      (tier.creditsExpire !== undefined && tier.credits === undefined)
    ) {
      return Result.fail(new CatalogCreditGrantInvalid({ tier: tier.id }));
    }
    if (tier.grants.length === 0) {
      return Result.fail(new CatalogEmptyTier({ tier: tier.id }));
    }
    // A line may name the pack it buys, and the name is checked here rather
    // than in the policy: a crossing is the wrong moment to discover a typo.
    const topUpPack = tier.topUp?.pack;
    if (topUpPack !== undefined && !packs.has(topUpPack)) {
      return Result.fail(new CatalogUnknownTopUpPack({ tier: tier.id, pack: topUpPack }));
    }
    // A price may be sold in several currencies, but each one is stated once,
    // and none of them may repeat the base currency.
    if (tier.price !== undefined) {
      const seen = new Set([tier.price.currency]);
      for (const entry of tier.price.additionalCurrencies ?? []) {
        if (seen.has(entry.currency)) {
          return Result.fail(
            new CatalogAdditionalCurrency({ tier: tier.id, currency: entry.currency }),
          );
        }
        seen.add(entry.currency);
      }
    }
    // A per-tier rate-card override only makes sense for a feature the catalog
    // prices in credits; anything else would be a card nothing reads.
    for (const feature of Object.keys(tier.rateCard ?? {})) {
      if (!creditPriced.has(feature)) {
        return Result.fail(new CatalogRateCardOverride({ tier: tier.id, feature }));
      }
    }
    const granted = new Set<string>();
    for (const grant of tier.grants) {
      if (!declared.has(grant.feature)) {
        return Result.fail(new CatalogUnknownFeature({ tier: tier.id, feature: grant.feature }));
      }
      if (granted.has(grant.feature)) {
        return Result.fail(
          new CatalogDuplicateAllowance({ tier: tier.id, feature: grant.feature }),
        );
      }
      granted.add(grant.feature);
      // A credit-priced feature spends the pool; an allowance would be a second
      // answer to how much is left.
      if (creditPriced.has(grant.feature)) {
        return Result.fail(
          new CatalogCreditFeatureHasAllowance({ tier: tier.id, feature: grant.feature }),
        );
      }
      // Unlimited means there is no end to be past, so an overage is only
      // meaningful when it allows: anything else describes a boundary that
      // cannot exist.
      if (grant.included === "unlimited" && grant.overage !== "allow") {
        return Result.fail(new CatalogUnlimitedOverage({ tier: tier.id, feature: grant.feature }));
      }
      // A flag has nothing to count, so it is granted with `grant()` and only
      // with `grant()`; a metered feature is the mirror image. Both directions
      // are refusals, because either one silently changes what usage recording
      // means for that feature.
      const flagFeature = kinds.get(grant.feature) === "flag";
      const quantityFeature = kinds.get(grant.feature) === "non_consumable";
      if (quantityFeature !== isQuantityGrant(grant)) {
        return Result.fail(new CatalogQuantityKind({ tier: tier.id, feature: grant.feature }));
      }
      if (quantityFeature) {
        if (grant.included === "unlimited") {
          return Result.fail(
            new CatalogQuantityIncluded({ tier: tier.id, feature: grant.feature }),
          );
        }
        if (grant.resets !== "never") {
          return Result.fail(new CatalogQuantityResets({ tier: tier.id, feature: grant.feature }));
        }
        for (const field of ["resetEvery", "carryCap", "moneyCap"] as const) {
          if (grant[field] !== undefined) {
            return Result.fail(
              new CatalogQuantityField({ tier: tier.id, feature: grant.feature, field }),
            );
          }
        }
        if (grant.carryOver === true) {
          return Result.fail(
            new CatalogQuantityField({
              tier: tier.id,
              feature: grant.feature,
              field: "carryOver",
            }),
          );
        }
        const quantityPricing = pricingOf(grant);
        if (quantityPricing !== null && quantityPricing._tag !== "unit") {
          return Result.fail(new CatalogQuantityPricing({ tier: tier.id, feature: grant.feature }));
        }
        if (grant.overage === "bill" && quantityPricing === null) {
          return Result.fail(
            new CatalogQuantityWithoutPrice({ tier: tier.id, feature: grant.feature }),
          );
        }
        if (grant.overage !== "bill" && quantityPricing !== null) {
          return Result.fail(
            new CatalogPricingWithoutBilling({ tier: tier.id, feature: grant.feature }),
          );
        }
        if (
          grant.cap !== undefined &&
          typeof grant.included === "number" &&
          grant.cap < grant.included
        ) {
          return Result.fail(new CatalogQuantityCap({ tier: tier.id, feature: grant.feature }));
        }
        if (grant.prorate !== undefined && grant.overage !== "bill") {
          return Result.fail(
            new CatalogQuantityField({ tier: tier.id, feature: grant.feature, field: "prorate" }),
          );
        }
        continue;
      }
      if (grant.prorate !== undefined) {
        return Result.fail(new CatalogProrateOnMetered({ tier: tier.id, feature: grant.feature }));
      }
      if (flagFeature && !isFlagGrant(grant)) {
        return Result.fail(new CatalogFlagNotGranted({ tier: tier.id, feature: grant.feature }));
      }
      if (!flagFeature && isFlagGrant(grant)) {
        return Result.fail(new CatalogFlagOnMetered({ tier: tier.id, feature: grant.feature }));
      }
      // A carry needs something to carry and a boundary to carry it over. A
      // flag has neither; an allowance that never resets has no boundary, so
      // the setting would silently do nothing.
      if (grant.carryOver === true && flagFeature) {
        return Result.fail(new CatalogCarryOverOnFlag({ tier: tier.id, feature: grant.feature }));
      }
      // A cap limits what is billed past `included`, so an allowance that never
      // bills past it cannot have one.
      if (grant.cap !== undefined && grant.overage !== "bill") {
        return Result.fail(new CatalogCapWithoutBilling({ tier: tier.id, feature: grant.feature }));
      }
      // A price prices the billable part, so it needs a bill; a money cap
      // needs a price to turn units into money.
      const pricingError = pricingErrorOf(tier, grant.feature, grant);
      if (pricingError !== null) return Result.fail(pricingError);
      if (grant.moneyCap !== undefined && pricingOf(grant) === null) {
        return Result.fail(
          new CatalogMoneyCapWithoutUnitPrice({ tier: tier.id, feature: grant.feature }),
        );
      }
      if (grant.carryOver === true && grant.resets === "never") {
        return Result.fail(
          new CatalogCarryOverNeverResets({ tier: tier.id, feature: grant.feature }),
        );
      }
      if (grant.carryOver !== true) {
        if (grant.carryCap !== undefined) {
          return Result.fail(
            new CatalogCarryWithoutCarry({
              tier: tier.id,
              feature: grant.feature,
              field: "carryCap",
            }),
          );
        }
      }
      if (grant.resetEvery !== undefined && grant.resets === "never") {
        return Result.fail(new CatalogResetEveryNever({ tier: tier.id, feature: grant.feature }));
      }
    }
  }

  return Result.succeed(catalog);
};

/**
 * The effectful form, for a `Stack` or a runtime binding. A failure is the
 * same tagged union `defineCatalog()` returns.
 *
 * ### In a Stack
 * **Example:** Refuse a bad catalog at deploy time
 * ```typescript
 * const billing = yield* Stack("Billing", {
 *   catalog: { features: [messages], tiers: [free, pro] },
 *   providers: [Memory()],
 * });
 * ```
 */
export const catalog = (input: CatalogInput): Effect.Effect<Catalog, CatalogError> =>
  Effect.fromResult(defineCatalog(input));

/** A declared tier, or `null` when the catalog has no such tier. */
export const tierOf = (catalog: Catalog, tierId: string): Tier | null =>
  catalog.tiers.find((tier) => tier.id === tierId) ?? null;

/** A declared feature, or `null` when the catalog has no such feature. */
export const featureOf = (catalog: Catalog, featureId: string): Feature | null =>
  catalog.features.find((feature) => feature.id === featureId) ?? null;

/**
 * Every credit-priced feature's rate card, keyed by feature id. A command
 * carries this because `decide` is pure and never sees the catalog.
 */
export const creditRatesOf = (catalog: Catalog): CreditRateCards => {
  const rates: Record<string, RateCard> = {};
  for (const feature of catalog.features) {
    if (feature.creditRates !== undefined) {
      rates[feature.id] = cardFromRates(feature.creditRates);
    } else if (feature.rateCard !== undefined) {
      rates[feature.id] = feature.rateCard;
    }
  }
  return rates;
};

/**
 * The rate cards a tier sells with: every feature's card, with the tier's own
 * overrides applied. A tier that states a card for one feature replaces only
 * that feature's card; everything else is the catalog's.
 */
export const ratesOf = (catalog: Catalog, tierId: string): CreditRateCards | null => {
  const tier = tierOf(catalog, tierId);
  if (tier === null) return null;
  const base = creditRatesOf(catalog);
  if (tier.rateCard === undefined) return base;
  return { ...base, ...tier.rateCard };
};

/** The credit terms a tier sells: its grant, when it expires, every rate, and its top-up line. */
export interface TierCreditTerms {
  readonly kind: TierKind;
  readonly credits: number;
  readonly creditsExpire: CreditsExpire;
  readonly rates: CreditRateCards;
  /** Credits at or below which a spend is a crossing, and how the tier refills. Absent means never. */
  readonly topUp?: TopUpTerms;
}

/** What a tier grants in credits, with the defaults the catalog implies. */
export const creditTermsOf = (catalog: Catalog, tierId: string): TierCreditTerms | null => {
  const tier = tierOf(catalog, tierId);
  if (tier === null) return null;
  return {
    kind: tier.kind ?? "subscription",
    credits: tier.credits ?? 0,
    creditsExpire: tier.creditsExpire ?? "period",
    rates: ratesOf(catalog, tierId) ?? {},
    ...(tier.topUp === undefined ? {} : { topUp: tier.topUp }),
  };
};

/**
 * Everything a `Subscribe`, `StartTrial` or `ChangeTier` carries that comes
 * from the catalog: the allowances, the price, and the credit terms. One
 * helper, so a caller cannot assemble half of a tier and forget a field the
 * guard would then refuse.
 */
export interface TierTerms extends TierCreditTerms {
  readonly allowances: Allowances;
  readonly price?: Price;
}

/** The command fields a tier implies, or `null` when the catalog lacks it. */
export const tierTermsOf = (
  catalog: Catalog,
  tierId: string,
  currency?: string,
): TierTerms | null => {
  const tier = tierOf(catalog, tierId);
  const allowances = allowancesOf(catalog, tierId);
  const terms = creditTermsOf(catalog, tierId);
  if (tier === null || allowances === null || terms === null) return null;
  const price =
    tier.price === undefined
      ? undefined
      : currency === undefined
        ? tier.price
        : (priceFor(tier.price, currency) ?? null);
  if (tier.price !== undefined && price === null) return null;
  return {
    ...terms,
    allowances,
    ...(price === undefined || price === null ? {} : { price }),
  };
};

/** Fold a tier's `grants` into the map a command and a view carry. */
export const allowancesOf = (catalog: Catalog, tierId: string): Allowances | null => {
  const tier = tierOf(catalog, tierId);
  if (tier === null) return null;
  const allowances: Record<string, Allowance> = {};
  for (const grant of tier.grants) allowances[grant.feature] = grant;
  return allowances;
};
