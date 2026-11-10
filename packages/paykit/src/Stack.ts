import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { UnitPrice, isQuantityGrant, pricingOf } from "./Allowance.ts";
import { catalog, type Catalog, type CatalogError, type CatalogInput } from "./Catalog.ts";
import { PaymentCapability, type MoneyProvider } from "./Payments.ts";
import { Pricing, pricingKey, soleUnitPriceOf, unitsOf } from "./Pricing.ts";
import { Price, type Tier } from "./Tier.ts";

/** A provider's price for a tier disagrees with the catalog. */
export class CatalogPriceMismatch extends Schema.TaggedError<CatalogPriceMismatch>()(
  "CatalogPriceMismatch",
  {
    tier: Schema.String,
    field: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  },
) {}

/** A priced tier has no provider that can sell it. */
export class NoPurchasePath extends Schema.TaggedError<NoPurchasePath>()("NoPurchasePath", {
  tier: Schema.String,
}) {}

/**
 * Two providers in one Stack share a name. `refs` is keyed by that name, so a
 * duplicate makes an account's vendor references ambiguous: a standing sold
 * through one would be upgraded through the other.
 */
export class ProviderDuplicate extends Schema.TaggedError<ProviderDuplicate>()(
  "ProviderDuplicate",
  {
    provider: Schema.String,
  },
) {}

/** A provider as deploy state can hold it: no layer, no HTTP. */
export const ProviderDescriptor = Schema.Struct({
  /** The name `refs` are keyed by, and the router's key. */
  name: Schema.String,
  kind: Schema.String,
  /** Whether this provider can report a payment, which a priced tier needs. */
  webhook: Schema.Boolean,
  capabilities: Schema.Array(PaymentCapability),
  prices: Schema.optional(Schema.Record(Schema.String, Price)),
  /** What the provider charges per billable unit, per tier and feature. */
  unitPrices: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, UnitPrice)),
  ),
  /** The full pricing a provider holds per billable feature. */
  usagePrices: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Pricing))),
  /** What the provider charges per seat, per tier and feature. */
  seatPrices: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, UnitPrice)),
  ),
  /** Whether the vendor's seat count is per feature or per subscription. */
  seatScope: Schema.optional(Schema.Literals(["feature", "subscription"])),
});

export type ProviderDescriptor = typeof ProviderDescriptor.Type;

/** Drop the runtime layer; keep what a deploy needs to validate and record. */
export const providerDescriptor = (provider: MoneyProvider): ProviderDescriptor => ({
  name: provider.name,
  kind: provider.kind,
  webhook: provider.webhook !== undefined,
  capabilities: [...provider.capabilities],
  ...(provider.prices === undefined ? {} : { prices: provider.prices }),
  ...(provider.unitPrices === undefined ? {} : { unitPrices: provider.unitPrices }),
  ...(provider.usagePrices === undefined ? {} : { usagePrices: provider.usagePrices }),
  ...(provider.seatPrices === undefined ? {} : { seatPrices: provider.seatPrices }),
  ...(provider.seatScope === undefined ? {} : { seatScope: provider.seatScope }),
});

/** The store a Stack writes its event log to. */
export type Store =
  | { readonly _tag: "MemoryStore" }
  | {
      readonly _tag: "PostgresStore";
      readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
      readonly schema: string;
    }
  | {
      readonly _tag: "SqliteStore";
      readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
      readonly schema: string;
    }
  | {
      readonly _tag: "MySQLStore";
      readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
    };

/** The in-memory store, for tests and `alchemy dev`. */
export const MemoryStore = (): Store => ({ _tag: "MemoryStore" });

/** The Postgres store config. The schema defaults to `billing`. */
export const Postgres = (props: {
  readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
  readonly schema?: string;
}): Store => ({
  _tag: "PostgresStore",
  url: props.url,
  schema: props.schema ?? "billing",
});

/** The MySQL store config. MySQL's namespace is the connection's database. */
export const MySQL = (props: {
  readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
}): Store => ({
  _tag: "MySQLStore",
  url: props.url,
});

/** The SQLite / D1 store config. The schema is unused there, kept for parity. */
export const Sqlite = (props: {
  readonly url: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
  readonly schema?: string;
}): Store => ({
  _tag: "SqliteStore",
  url: props.url,
  schema: props.schema ?? "billing",
});

/** What a Stack declares. */
export interface ValidateStackProps {
  /** Plain catalog data; provider ids belong in provider config, never here. */
  readonly catalog: CatalogInput;
  /**
   * The money plane, in preference order. The first is what a new account
   * starts on; an account that already holds a vendor reference stays on the
   * provider that reference names. Every name must be distinct.
   */
  readonly providers?: ReadonlyArray<MoneyProvider>;
  readonly store?: Store;
}

/** A validated stack: the catalog, the providers, and the store. */
export interface ValidatedBillingStack {
  readonly id: string;
  readonly catalog: Catalog;
  readonly providers: ReadonlyArray<MoneyProvider>;
  readonly store: Store;
}

const priceField = (price: Price, field: keyof Price): string =>
  typeof price[field] === "object" ? JSON.stringify(price[field]) : String(price[field]);

/** Validate a catalog against serializable provider descriptors. */
export const validateProviderMappings = (
  parsed: Catalog,
  providers: ReadonlyArray<ProviderDescriptor>,
): CatalogPriceMismatch | NoPurchasePath | ProviderDuplicate | null => {
  // Several providers are fine — `paymentsRouter` keys them by name and the
  // account's `refs` pick one — but two with the same name make that choice
  // ambiguous.
  const seen = new Set<string>();

  for (const provider of providers) {
    if (seen.has(provider.name)) return new ProviderDuplicate({ provider: provider.name });
    seen.add(provider.name);
  }

  for (const provider of providers) {
    for (const [tierId, mapped] of Object.entries(provider.prices ?? {})) {
      const tier = parsed.tiers.find((candidate) => candidate.id === tierId);

      if (tier === undefined) {
        return new CatalogPriceMismatch({
          tier: tierId,
          field: "tier",
          expected: "in catalog",
          actual: "missing",
        });
      }

      const mismatch = checkPrice(tier, mapped);

      if (mismatch !== null) return mismatch;
    }

    // A pricing the provider states and the catalog does not is as much a
    // disagreement as a different rate: the vendor would bill a feature the
    // entitlement plane never priced.
    for (const [tierId, mapped] of Object.entries(provider.usagePrices ?? {})) {
      const tier = parsed.tiers.find((candidate) => candidate.id === tierId);

      if (tier === undefined) {
        return new CatalogPriceMismatch({
          tier: tierId,
          field: "usagePrices",
          expected: "in catalog",
          actual: "missing",
        });
      }

      for (const [featureId, actual] of Object.entries(mapped)) {
        const grant = tier.grants.find((candidate) => candidate.feature === featureId);
        const expected = grant === undefined ? null : pricingOf(grant);

        if (expected === null) {
          return new CatalogPriceMismatch({
            tier: tier.id,
            field: `pricing.${featureId}`,
            expected: "none",
            actual: pricingKey(actual),
          });
        }

        if (pricingKey(expected) !== pricingKey(actual)) {
          return new CatalogPriceMismatch({
            tier: tier.id,
            field: `pricing.${featureId}`,
            expected: pricingKey(expected),
            actual: pricingKey(actual),
          });
        }
      }
    }

    // A unit price the provider states through the one-rate shorthand is
    // checked the same way, unless the full pricing already covered it.
    for (const [tierId, mapped] of Object.entries(provider.unitPrices ?? {})) {
      const tier = parsed.tiers.find((candidate) => candidate.id === tierId);

      if (tier === undefined) {
        return new CatalogPriceMismatch({
          tier: tierId,
          field: "unitPrices",
          expected: "in catalog",
          actual: "missing",
        });
      }

      for (const [featureId, unitPrice] of Object.entries(mapped)) {
        if (provider.usagePrices?.[tierId]?.[featureId] !== undefined) continue;
        const grant = tier.grants.find((candidate) => candidate.feature === featureId);
        const pricing = grant === undefined ? null : pricingOf(grant);
        const expected = pricing === null ? undefined : (soleUnitPriceOf(pricing) ?? undefined);
        const mismatch = checkUnitPrice(tier.id, featureId, expected, unitPrice);

        if (mismatch !== null) return mismatch;
      }
    }

    // A provider that owns the subscription item's quantity must map every
    // billable seat, or the seat change would reach a vendor that has no price
    // to put it on. A provider without the capability keeps the local
    // proration, so it is not asked for one.
    if (provider.capabilities.includes("quantity")) {
      for (const [tierId] of Object.entries(provider.prices ?? {})) {
        const tier = parsed.tiers.find((candidate) => candidate.id === tierId);

        if (tier === undefined) continue;
        let billableSeats = 0;

        for (const grant of tier.grants) {
          if (!isQuantityGrant(grant) || grant.overage !== "bill") continue;
          billableSeats += 1;
          const pricing = pricingOf(grant);
          const unitPrice = pricing === null ? null : soleUnitPriceOf(pricing);

          if (unitPrice === null) continue;
          const mapped = provider.seatPrices?.[tierId]?.[grant.feature];

          if (mapped === undefined) {
            return new CatalogPriceMismatch({
              tier: tierId,
              field: `seatPrice.${grant.feature}`,
              expected: `${unitPrice.amount} ${unitPrice.currency}`,
              actual: "missing",
            });
          }

          if (mapped.amount !== unitPrice.amount || mapped.currency !== unitPrice.currency) {
            return new CatalogPriceMismatch({
              tier: tierId,
              field: `seatPrice.${grant.feature}`,
              expected: `${unitPrice.amount} ${unitPrice.currency}`,
              actual: `${mapped.amount} ${mapped.currency}`,
            });
          }
        }

        // Polar's seat count is one number on the subscription. A tier with
        // two billable seat features would make `setQuantity` ambiguous, so the
        // deploy refuses it rather than choosing one.
        if (provider.seatScope === "subscription" && billableSeats > 1) {
          return new CatalogPriceMismatch({
            tier: tierId,
            field: "seatPrices",
            expected: "one billable seat feature",
            actual: `${billableSeats}`,
          });
        }
      }
    }

    // A provider that can meter a postpaid tier must map every billable
    // feature, or the close would have a price to charge and no meter to send
    // the quantity to. A provider that maps no price for the tier is not
    // selling it here, so it is not asked for a meter.
    if (provider.capabilities.includes("usage")) {
      for (const [tierId] of Object.entries(provider.prices ?? {})) {
        const tier = parsed.tiers.find((candidate) => candidate.id === tierId);

        if (tier === undefined) continue;

        for (const grant of tier.grants) {
          // A seat is billed by the subscription's quantity, not a usage meter.
          if (isQuantityGrant(grant)) continue;
          const pricing = pricingOf(grant);

          if (pricing === null) continue;
          const mappedPricing = provider.usagePrices?.[tierId]?.[grant.feature];

          if (mappedPricing !== undefined) {
            if (pricingKey(pricing) !== pricingKey(mappedPricing)) {
              return new CatalogPriceMismatch({
                tier: tierId,
                field: `pricing.${grant.feature}`,
                expected: pricingKey(pricing),
                actual: pricingKey(mappedPricing),
              });
            }

            continue;
          }

          const unitPrice = soleUnitPriceOf(pricing);

          if (unitPrice === null) {
            // A ladder has no single rate to hand the one-rate shorthand; the
            // provider has to state the full pricing through `usagePrices`.
            return new CatalogPriceMismatch({
              tier: tierId,
              field: `pricing.${grant.feature}`,
              expected: "a pricing the provider can meter",
              actual: pricingKey(pricing),
            });
          }

          const mappedUnitPrice = provider.unitPrices?.[tierId]?.[grant.feature];

          if (mappedUnitPrice === undefined) {
            return new CatalogPriceMismatch({
              tier: tierId,
              field: `unitPrice.${grant.feature}`,
              expected: unitPriceText(unitPrice),
              actual: "missing",
            });
          }

          if (
            mappedUnitPrice.amount !== unitPrice.amount ||
            mappedUnitPrice.currency !== unitPrice.currency ||
            unitsOf(mappedUnitPrice) !== unitsOf(unitPrice)
          ) {
            return new CatalogPriceMismatch({
              tier: tierId,
              field: `unitPrice.${grant.feature}`,
              expected: unitPriceText(unitPrice),
              actual: unitPriceText(mappedUnitPrice),
            });
          }
        }
      }
    }
  }

  for (const tier of parsed.tiers) {
    if (tier.price === undefined) continue;

    const canSell = providers.some(
      (provider) =>
        provider.capabilities.includes("checkout") || provider.capabilities.includes("invoice"),
    );

    if (!canSell) return new NoPurchasePath({ tier: tier.id });
  }

  return null;
};

/** A unit price as an operator reads it, including its package size. */
const unitPriceText = (price: UnitPrice): string =>
  unitsOf(price) === 1
    ? `${price.amount} ${price.currency}`
    : `${price.amount} ${price.currency} per ${unitsOf(price)} units`;

/** Compare one provider unit price with the catalog's, or with the absence of one. */
const checkUnitPrice = (
  tier: string,
  feature: string,
  expected: UnitPrice | undefined,
  actual: UnitPrice,
): CatalogPriceMismatch | null => {
  const field = `unitPrice.${feature}`;

  if (expected === undefined) {
    return new CatalogPriceMismatch({
      tier,
      field,
      expected: "none",
      actual: unitPriceText(actual),
    });
  }

  if (
    expected.amount !== actual.amount ||
    expected.currency !== actual.currency ||
    unitsOf(expected) !== unitsOf(actual)
  ) {
    return new CatalogPriceMismatch({
      tier,
      field,
      expected: unitPriceText(expected),
      actual: unitPriceText(actual),
    });
  }

  return null;
};

/** Compare every mapped tier to the one meaning the catalog gives it. */
const checkPrice = (tier: Tier, mapped: Price): CatalogPriceMismatch | null => {
  if (tier.price === undefined) {
    return new CatalogPriceMismatch({
      tier: tier.id,
      field: "price",
      expected: "none",
      actual: priceField(mapped, "amount"),
    });
  }

  for (const field of ["amount", "currency", "interval"] as const) {
    if (tier.price[field] !== mapped[field]) {
      return new CatalogPriceMismatch({
        tier: tier.id,
        field,
        expected: priceField(tier.price, field),
        actual: priceField(mapped, field),
      });
    }
  }

  return null;
};

/**
 * Validate a billing declaration without recording it: the catalog, every
 * provider mapping, and the store. `Paykit.BillingStack` is the deploy call;
 * this is the pure half, for a test or a tool that wants the validated value
 * without an Alchemy stack.
 */
export const validateStack = (
  id: string,
  props: ValidateStackProps,
): Effect.Effect<
  ValidatedBillingStack,
  CatalogError | CatalogPriceMismatch | NoPurchasePath | ProviderDuplicate
> =>
  Effect.gen(function* () {
    const parsed = yield* catalog(props.catalog);
    const providers = props.providers ?? [];
    const invalid = validateProviderMappings(parsed, providers.map(providerDescriptor));

    if (invalid !== null) return yield* invalid;

    return {
      id,
      catalog: parsed,
      providers,
      store: props.store ?? MemoryStore(),
    };
  });
