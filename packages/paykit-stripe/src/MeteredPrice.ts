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
  type PriceTiersList,
  type TransformQuantity,
} from "@distilled.cloud/stripe/stripe";
import {
  encodeVendorPart,
  unitAmountDecimalOf,
  unitsOf,
  type Pricing,
  type UnitPrice,
} from "@potion.run/paykit";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Context from "effect/Context";
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

const sortedTiers = (tiers: PriceTiersList | undefined): string =>
  JSON.stringify(
    (tiers ?? []).map((tier) => ({
      upTo: tier.up_to === null ? "inf" : tier.up_to,
      amount: amountKey(tier.unit_amount_decimal ?? tier.unit_amount),
    })),
  );

const desiredTiers = (tiers: CreatePriceRequestTiersList): string =>
  JSON.stringify(
    tiers.map((tier) => ({
      upTo: tier.up_to,
      amount: amountKey(tier.unit_amount_decimal ?? tier.unit_amount),
    })),
  );

const sameTiers = (observed: PriceTiersList | undefined, desired: CreatePriceRequestTiersList) =>
  sortedTiers(observed) === desiredTiers(desired);

const sameTransform = (
  observed: TransformQuantity | null,
  desired: TransformQuantity | undefined,
): boolean =>
  desired === undefined
    ? observed === null
    : observed?.divide_by === desired.divide_by && observed.round === desired.round;

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
    return price.tiers_mode === "volume"
      ? { _tag: "volume", currency: price.currency, bands: bands as never }
      : { _tag: "graduated", currency: price.currency, bands: bands as never };
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

const matches = (price: StripePrice, props: MeteredPriceProps): boolean => {
  const pricing = props.pricing;
  const tiers = stripeTiersOf(pricing);
  const transform = stripeTransformOf(pricing);
  return (
    price.billing_scheme === (pricing._tag === "unit" ? "per_unit" : "tiered") &&
    price.currency === currencyOf(pricing) &&
    price.recurring?.interval === props.interval &&
    price.recurring?.usage_type === "metered" &&
    price.recurring?.meter === props.meter &&
    sameTransform(price.transform_quantity, transform) &&
    (pricing._tag === "unit"
      ? price.unit_amount === pricing.unitPrice.amount
      : price.tiers_mode === pricing._tag && sameTiers(price.tiers, tiers))
  );
};

const isMissing = (error: { readonly _tag?: string }) => error._tag === "NotFound";

const getById = (price: string) =>
  GetPrice({ price }).pipe(Effect.catchIf(isMissing, () => Effect.undefined));

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

const listByActive = Effect.fn(function* (active: boolean) {
  const prices: StripePrice[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPrices({
      active,
      limit: LIST_PAGE_SIZE,
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
  for (const price of prices) {
    if (yield* hasAlchemyMetadata(id, tagRecord(price.metadata))) return price;
  }
  return undefined;
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

export const MeteredPriceProvider = () =>
  Provider.succeed(MeteredPrice, {
    stables: ["id", "product", "currency", "created"],
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
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
                unit_amount: news.pricing.unitPrice.amount,
                ...(transform === undefined ? {} : { transform_quantity: transform }),
              }
            : { billing_scheme: "tiered", tiers_mode: news.pricing._tag, tiers }),
          lookup_key: desiredLookupKey,
          transfer_lookup_key: true,
          metadata,
        });
      }

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
      return attrsOf(updated);
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
  collection.providers[MeteredPrice.Type] = Context.get(
    context,
    Provider.Provider(MeteredPrice.Type) as unknown as Context.Key<never, never>,
  ) as never;
});
