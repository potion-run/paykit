import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Allowances, isFlagGrant, type Allowance } from "./Allowance.ts";
import { CreditRateCards, Feature } from "./Feature.ts";
import { CreditsExpire, Price, Tier, type TierKind } from "./Tier.ts";

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
  CatalogUnitPriceWithoutBilling,
  CatalogMoneyCapWithoutUnitPrice,
  CatalogUnitPriceCurrency,
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
export const defineCatalog = (input: CatalogInput): Result.Result<Catalog, CatalogError> => {
  const decoded = Schema.decodeResult(Catalog)(input);
  if (Result.isFailure(decoded)) {
    return Result.fail(new CatalogInvalid({ message: decoded.failure.message }));
  }
  const catalog = decoded.success;

  const duplicateFeature = duplicateOf(catalog.features, (feature) => feature.id);
  if (duplicateFeature !== null) {
    return Result.fail(new CatalogDuplicateFeature({ feature: duplicateFeature }));
  }

  const duplicateTier = duplicateOf(catalog.tiers, (tier) => tier.id);
  if (duplicateTier !== null) {
    return Result.fail(new CatalogDuplicateTier({ tier: duplicateTier }));
  }

  const declared = new Set(catalog.features.map((feature) => feature.id));
  const kinds = new Map(catalog.features.map((feature) => [feature.id, feature.kind]));
  const creditPriced = new Set<string>();
  for (const feature of catalog.features) {
    const rates = feature.creditRates;
    if (rates === undefined) continue;
    if (feature.kind === "flag") {
      return Result.fail(new CatalogCreditRatesOnFlag({ feature: feature.id }));
    }
    // `undefined` is checked as a key, not a value: a rate of 0 is refused
    // below, and a missing default by itself.
    if (!Object.hasOwn(rates, "default")) {
      return Result.fail(new CatalogCreditRateMissing({ feature: feature.id }));
    }
    for (const [dimension, rate] of Object.entries(rates)) {
      if (rate <= 0) {
        return Result.fail(new CatalogCreditRateInvalid({ feature: feature.id, dimension }));
      }
    }
    creditPriced.add(feature.id);
  }
  for (const tier of catalog.tiers) {
    const kind = tier.kind ?? "subscription";
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
    // One standing has one currency. Every unit price in the tier must agree
    // with the tier's own price (when it has one) and with each other.
    const unitCurrencies = new Set(
      tier.grants.flatMap((grant) =>
        grant.unitPrice === undefined ? [] : [grant.unitPrice.currency],
      ),
    );
    const firstUnitCurrency = [...unitCurrencies][0];
    if (
      unitCurrencies.size > 1 ||
      (firstUnitCurrency !== undefined &&
        tier.price !== undefined &&
        firstUnitCurrency !== tier.price.currency)
    ) {
      const offending =
        unitCurrencies.size > 1
          ? [...unitCurrencies][1]!
          : (firstUnitCurrency ?? tier.price!.currency);
      return Result.fail(new CatalogUnitPriceCurrency({ tier: tier.id, currency: offending }));
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
      // A unit price prices the billable part, so it needs a bill; a money cap
      // needs a unit price to turn units into money.
      if (grant.unitPrice !== undefined && grant.overage !== "bill") {
        return Result.fail(
          new CatalogUnitPriceWithoutBilling({ tier: tier.id, feature: grant.feature }),
        );
      }
      if (grant.moneyCap !== undefined && grant.unitPrice === undefined) {
        return Result.fail(
          new CatalogMoneyCapWithoutUnitPrice({ tier: tier.id, feature: grant.feature }),
        );
      }
      if (grant.carryOver === true && grant.resets === "never") {
        return Result.fail(
          new CatalogCarryOverNeverResets({ tier: tier.id, feature: grant.feature }),
        );
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
  const rates: Record<string, Record<string, number>> = {};
  for (const feature of catalog.features) {
    if (feature.creditRates !== undefined) rates[feature.id] = { ...feature.creditRates };
  }
  return rates;
};

/** The credit terms a tier sells: its grant, when it expires, every rate, and its top-up line. */
export interface TierCreditTerms {
  readonly kind: TierKind;
  readonly credits: number;
  readonly creditsExpire: CreditsExpire;
  readonly rates: CreditRateCards;
  /** Credits at or below which a spend buys the deployment's pack. Absent means never. */
  readonly topUp?: number;
}

/** What a tier grants in credits, with the defaults the catalog implies. */
export const creditTermsOf = (catalog: Catalog, tierId: string): TierCreditTerms | null => {
  const tier = tierOf(catalog, tierId);
  if (tier === null) return null;
  return {
    kind: tier.kind ?? "subscription",
    credits: tier.credits ?? 0,
    creditsExpire: tier.creditsExpire ?? "period",
    rates: creditRatesOf(catalog),
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
export const tierTermsOf = (catalog: Catalog, tierId: string): TierTerms | null => {
  const tier = tierOf(catalog, tierId);
  const allowances = allowancesOf(catalog, tierId);
  const terms = creditTermsOf(catalog, tierId);
  if (tier === null || allowances === null || terms === null) return null;
  return {
    ...terms,
    allowances,
    ...(tier.price === undefined ? {} : { price: tier.price }),
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
