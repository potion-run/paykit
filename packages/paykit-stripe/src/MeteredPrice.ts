import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
} from "@alchemy.run/stripe/Metadata";
import { Providers } from "@alchemy.run/stripe/Providers";
import {
  CreatePrice,
  GetPrice,
  GetPrices,
  UpdatePrice,
  type CreatePriceRequestTiersList,
  type Price as StripePrice,
  type TransformQuantity,
} from "@distilled.cloud/stripe/stripe";
import {
  encodeVendorPart,
  unitAmountDecimalOf,
  unitsOf,
  type PriceBand,
  type Pricing,
  type UnitPrice,
} from "@potion.run/paykit";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** One band as Stripe's tier API states it. */
const stripeTierOf = (band: {
  readonly upTo: number | "inf";
  readonly unitPrice: UnitPrice;
}): CreatePriceRequestTiersList[number] => ({
  up_to: band.upTo,
  ...(unitsOf(band.unitPrice) === 1
    ? { unit_amount: band.unitPrice.amount }
    : { unit_amount_decimal: unitAmountDecimalOf(band.unitPrice) }),
});

const currencyOf = (pricing: Pricing): string =>
  pricing._tag === "unit" ? pricing.unitPrice.currency : pricing.currency;

/** The tiers a banded pricing states, in Stripe's spelling. */
export const stripeTiersOf = (pricing: Pricing): CreatePriceRequestTiersList =>
  pricing._tag === "unit"
    ? []
    : pricing.bands.map((band) => stripeTierOf({ upTo: band.upTo, unitPrice: band.unitPrice }));

/** The package transform a one-rate package needs, if it has one. */
export const stripeTransformOf = (pricing: Pricing): TransformQuantity | undefined =>
  pricing._tag === "unit" && unitsOf(pricing.unitPrice) > 1
    ? { divide_by: unitsOf(pricing.unitPrice), round: "up" }
    : undefined;

export const meteredPriceNameOf = (stage: string, tier: string, feature: string): string =>
  `paykit:${encodeVendorPart(stage)}:${encodeVendorPart(tier)}:usage:${encodeVendorPart(feature)}`;

const amountKey = (value: number | string | null | undefined): string | null =>
  value === null || value === undefined ? null : String(Number(value));

const pricingSignature = (pricing: Pricing): string =>
  JSON.stringify({
    tag: pricing._tag,
    currency: currencyOf(pricing),
    unit: pricing._tag === "unit" ? unitAmountDecimalOf(pricing.unitPrice) : null,
    tiers: stripeTiersOf(pricing).map((tier) => ({
      upTo: tier.up_to,
      amount: amountKey(tier.unit_amount_decimal ?? tier.unit_amount),
    })),
    transform: stripeTransformOf(pricing) ?? null,
  });

export interface MeteredPriceProps {
  /** The Stripe product the price belongs to (`prod_…`). */
  readonly product: string;
  /** Billing frequency, in Stripe's spelling. */
  readonly interval: "month" | "year";
  /** The billing meter the price counts. */
  readonly meter: string;
  /** `paykit:<stage>:<tier>:usage:<feature>`, the identity a restore finds. */
  readonly lookupKey: string;
  /** The catalog pricing, including a package size or a band ladder. */
  readonly pricing: Pricing;
}

export type MeteredPrice = Resource<
  "Paykit.Stripe.MeteredPrice",
  MeteredPriceProps,
  {
    id: string;
    product: string;
    currency: string;
    interval: "month" | "year";
    meter: string;
    lookupKey: string;
    pricing: Pricing;
    active: boolean;
    created: number;
  },
  never,
  Providers
>;

/**
 * A Stripe metered price that states more than one unit amount: a package
 * transform or a graduated/volume ladder. It is the shape Alchemy's `Price`
 * cannot express, kept here so `StripePrices` can reconcile it like any other
 * price while `Stripe.Price` remains the one-rate path.
 *
 * The lookup key is the identity; a changed pricing creates a new price and
 * transfers the key onto it, because Stripe prices are immutable and an
 * invoice may still reference the old one.
 *
 * @resource
 * @product Product
 */
export const MeteredPrice = Resource<MeteredPrice>("Paykit.Stripe.MeteredPrice");

const toPricing = (price: StripePrice): Pricing | null => {
  if (price.billing_scheme === "tiered") {
    const bands = (price.tiers ?? []).map((tier) => ({
      upTo: tier.up_to === null ? ("inf" as const) : tier.up_to,
      unitPrice: {
        amount: Number(tier.unit_amount_decimal ?? tier.unit_amount ?? 0),
        currency: price.currency,
      },
    }));

    if (bands.length === 0) return null;

    const nonEmptyBands: [PriceBand, ...Array<PriceBand>] = [bands[0]!, ...bands.slice(1)];

    return price.tiers_mode === "volume"
      ? { _tag: "volume", currency: price.currency, bands: nonEmptyBands }
      : { _tag: "graduated", currency: price.currency, bands: nonEmptyBands };
  }

  if (price.unit_amount === null) return null;

  return {
    _tag: "unit",
    unitPrice: {
      amount: price.unit_amount,
      currency: price.currency,
      ...(price.transform_quantity === null ? {} : { units: price.transform_quantity.divide_by }),
    },
  };
};

// SAFETY: the catalog only sells metered prices on a monthly or annual tier, so
// Stripe's day and week intervals cannot reach this mapping.
const attrsOf = (price: StripePrice): MeteredPrice["Attributes"] => ({
  id: price.id,
  product: typeof price.product === "string" ? price.product : price.product.id,
  currency: price.currency,
  interval: (price.recurring?.interval ?? "month") as "month" | "year",
  meter: price.recurring?.meter ?? "",
  lookupKey: price.lookup_key ?? "",
  pricing: toPricing(price) ?? { _tag: "unit", unitPrice: { amount: 0, currency: price.currency } },
  active: price.active,
  created: price.created,
});

export const shouldReplace = (
  news: MeteredPriceProps,
  output: MeteredPrice["Attributes"] | undefined,
): boolean =>
  output !== undefined &&
  (news.product !== output.product ||
    news.interval !== output.interval ||
    news.meter !== output.meter ||
    pricingSignature(news.pricing) !== pricingSignature(output.pricing));

const matches = (price: StripePrice, props: MeteredPriceProps): boolean =>
  price.active &&
  price.billing_scheme === (props.pricing._tag === "unit" ? "per_unit" : "tiered") &&
  price.recurring?.usage_type === "metered" &&
  !shouldReplace(props, attrsOf(price));

const isMissing = (error: { readonly _tag?: string }) => error._tag === "NotFound";

const getById = (price: string) =>
  GetPrice({ price, expand: ["tiers"] }).pipe(Effect.catchIf(isMissing, () => Effect.undefined));

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

const listByActive = Effect.fn(function* (active: boolean) {
  const prices: StripePrice[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPrices({
      active,
      limit: LIST_PAGE_SIZE,
      // Stripe omits a price's tiers unless the list expands them. Without
      // this, a tiered price never matches its desired tiers and every
      // reconcile creates another generation.
      expand: ["data.tiers"],
      ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
    });

    prices.push(...response.data);

    if (!response.has_more || response.data.length === 0) break;
    startingAfter = response.data[response.data.length - 1]?.id;

    if (startingAfter === undefined) break;
  }

  return prices;
});

const listAll = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all([listByActive(true), listByActive(false)], {
    concurrency: 2,
  });

  const seen = new Set<string>();

  return [...active, ...inactive].filter((price) => {
    if (seen.has(price.id)) return false;
    seen.add(price.id);

    return true;
  });
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const prices = yield* listAll();
  const found: StripePrice[] = [];

  for (const price of prices) {
    if (yield* hasAlchemyMetadata(id, tagRecord(price.metadata))) found.push(price);
  }

  // A failed destroy leaves every retained generation behind with the same
  // ownership metadata. Prefer the newest one; the oldest may predate a
  // field this provider now states, and reusing it would hide that drift.
  found.sort((left, right) => right.created - left.created);

  return found.at(0);
});

const observe = Effect.fn(function* (input: { id?: string; logicalId: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);

    if (byId !== undefined) return byId;
  }

  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (id: string) {
  return yield* createInternalMetadata(id);
});

export class MeteredPriceLookupKeyNotTransferred extends Data.TaggedError(
  "Paykit.Stripe.MeteredPriceLookupKeyNotTransferred",
)<{ readonly id: string; readonly lookupKey: string }> {}

const ensureLookupKey = Effect.fn(function* (price: StripePrice, lookupKey: string) {
  if ((price.lookup_key ?? "") === lookupKey) return price;

  const updated = yield* UpdatePrice({
    price: price.id,
    lookup_key: lookupKey,
    transfer_lookup_key: true,
  });

  if ((updated.lookup_key ?? "") !== lookupKey) {
    return yield* new MeteredPriceLookupKeyNotTransferred({ id: updated.id, lookupKey });
  }

  return updated;
});

export const MeteredPriceProvider = () =>
  Provider.succeed(MeteredPrice, {
    stables: ["id", "product", "currency", "created"],
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;

      if (shouldReplace(news, output)) return { action: "replace" } as const;

      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({ id: output?.id, logicalId: id });

      if (existing === undefined) return undefined;
      const attrs = attrsOf(existing);

      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata))) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const prices = (yield* listAll()).filter((price) => price.active);

      return prices
        .filter((price) => price.metadata[alchemyMetadataKeys.stack] !== undefined)
        .map(attrsOf);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const metadata = yield* desiredMetadata(id);
      const desiredLookupKey = news.lookupKey;
      let current = yield* observe({ id: output?.id, logicalId: id });

      if (current !== undefined && !matches(current, news)) current = undefined;

      if (current === undefined) {
        const tiers = stripeTiersOf(news.pricing);
        const transform = stripeTransformOf(news.pricing);
        current = yield* CreatePrice({
          product: news.product,
          currency: currencyOf(news.pricing),
          recurring: { interval: news.interval, usage_type: "metered", meter: news.meter },
          ...(news.pricing._tag === "unit"
            ? {
                billing_scheme: "per_unit",
                unit_amount: news.pricing.unitPrice.amount,
                ...(transform === undefined ? {} : { transform_quantity: transform }),
              }
            : { billing_scheme: "tiered", tiers_mode: news.pricing._tag, tiers }),
          lookup_key: desiredLookupKey,
          transfer_lookup_key: true,
          metadata,
        });
      }

      current = yield* ensureLookupKey(current, desiredLookupKey);

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const lookupKeyChanged = (current.lookup_key ?? "") !== desiredLookupKey;

      if (!metadataChanged && !lookupKeyChanged) return attrsOf(current);

      const updated = yield* UpdatePrice({
        price: current.id,
        ...(lookupKeyChanged ? { lookup_key: desiredLookupKey, transfer_lookup_key: true } : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });

      return attrsOf(yield* ensureLookupKey(updated, desiredLookupKey));
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);

      if (existing === undefined || !existing.active) return;
      yield* UpdatePrice({ price: existing.id, active: false }).pipe(
        Effect.catchIf(isMissing, () => Effect.void),
      );
    }),
  });

/**
 * Make the resource's provider visible to the stack's Stripe provider
 * collection. `StripePrices` calls this before it declares one, so a stack that
 * already mounts `Stripe.providers()` needs no second provider layer.
 */
export const registerMeteredPriceProvider = Effect.gen(function* () {
  const collection = Option.getOrUndefined(yield* Effect.serviceOption(Providers));

  if (collection === undefined || collection.get(MeteredPrice.Type) !== undefined) return;
  const context = yield* Layer.build(MeteredPriceProvider());
  const providerService: unknown = Provider.Provider(MeteredPrice.Type);
  // SAFETY: `Provider.Provider` is `Context.Service()(type)` at runtime, so the
  // key it names is the service the layer just built; its declared type models
  // the provider as an Effect rather than as a `Context.Key`.
  const providerKey = providerService as Context.Key<never, Provider.ProviderService>;

  collection.providers[MeteredPrice.Type] = Context.get(context, providerKey);
});
