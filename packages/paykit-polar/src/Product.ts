import * as Polar from "@distilled.cloud/polar";
import { encodeVendorPart, type Price, type TierKind, type UnitPrice } from "@potion.run/paykit";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/** The stage-qualified name a tier's Polar product carries, and its identity. */
export const productNameOf = (stage: string, tier: string): string =>
  `paykit:${encodeVendorPart(stage)}:${encodeVendorPart(tier)}`;

/**
 * The prefix every product name this stage owns starts with. `paykit` is the
 * library's, the stage is what keeps two stacks in one Polar organization
 * apart, and the trailing colon is what stops `prod` from matching
 * `production`.
 *
 * Meters share the prefix (`paykit:<stage>:meter:<feature>`), so a sweep over
 * products narrows on the vendor's product list before this decides.
 */
export const productNamePrefixOf = (stage: string): string => `paykit:${encodeVendorPart(stage)}:`;

/** The metadata key that names the paykit tier; Polar has no lookup key. */
export const PAYKIT_TIER = "paykit_tier";

export interface ProductProps {
  /** The paykit tier this product sells; with the stage, its identity. */
  readonly tier: string;
  /** A subscription repeats; a one-off pack is a single payment. */
  readonly kind?: TierKind;
  /**
   * The catalog's price, embedded in Polar's product rather than a price
   * object. Changing it replaces the product.
   */
  readonly price: Price;
  /** A description shown at checkout and on invoices. */
  readonly description?: string;
  /**
   * One metered price per billable feature, with the meter that counts it. A
   * change to either replaces the product, because Polar embeds the price in
   * the product and a metered price is create-only.
   */
  readonly usage?: ReadonlyArray<ProductUsage>;
}

/** One metered price embedded in a product. */
export interface ProductUsage {
  /** The Polar meter id (`mtr_…`) the price counts. */
  readonly meterId: string;
  /** What one billable unit costs, in minor units. */
  readonly unitPrice: UnitPrice;
}

export type Product = Resource<
  "Polar.Product",
  ProductProps,
  {
    /** Polar product id (`prod_…`). */
    id: string;
    /** The stage-qualified name, `paykit:<encoded stage>:<encoded tier>`. */
    name: string;
    /** The paykit tier this product sells. */
    tier: string;
    /** A subscription repeats; a one-off pack is a single payment. */
    kind: TierKind;
    /** The fixed price Polar embeds in the product. */
    priceId: string;
    /** The catalog price the product currently carries. */
    price: Price;
    /** The metered prices the product currently carries, by meter. */
    usage: ReadonlyArray<ProductUsage>;
    /** Whether Polar has archived the product. */
    archived: boolean;
    /** Polar's creation timestamp, used to pick the newest generation. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A Polar product that sells one tier at the price the catalog states.
 *
 * Polar embeds prices in the product, so the price is a prop of this resource
 * and a price change replaces the product. That difference from Stripe stops
 * here: `PolarPrices` returns the tier → product id map, and
 * `@potion.run/paykit`'s `PolarTier` keeps its `{ price, productId, usage? }`
 * shape.
 *
 * The identity is Polar's own metadata: `metadata.paykit_tier = "<tier>"` plus
 * a stage-qualified name, `paykit:<stage>:<tier>`. A restored state reconciles
 * to the same product instead of creating a second one, and a price change is
 * a new generation of the same identity.
 *
 * ### Declaring a product
 * **Example:** One product per tier, from the catalog
 * ```typescript
 * const sold = yield* PolarPrices("Prices", { tiers: { pro: proPrice } });
 * // sold.products.pro is an Output that resolves to the Polar product id while
 * // the stack runs. Give it to the app's runtime, where `Polar({ tiers })` needs it.
 * ```
 *
 * ### Replacing a price
 * **Example:** A changed amount is a new generation
 * ```typescript
 * // A changed amount creates a second product with the same
 * // `paykit:<stage>:<tier>` identity. The old product stays in Polar, and a
 * // state-lost deploy adopts the newest generation rather than creating one.
 * const sold = yield* PolarPrices("Prices", { tiers: { pro: { ...proPrice, amount: 2400 } } });
 * ```
 *
 * ### Retiring a tier
 * **Example:** A tier leaves the catalog
 * ```typescript
 * // `RemovalPolicy.retain` skips deletion: the product stays in Polar for the
 * // invoices that reference it, and only Alchemy's state row goes away.
 * yield* PolarPrices("Prices", { tiers: {} });
 * ```
 *
 * @resource
 * @product Product
 */
export const Product = Resource<Product>("Polar.Product");

type VendorProduct = Polar.Product;
type VendorPrice = VendorProduct["prices"][number];

type FixedPrice = {
  readonly id: string;
  readonly price_amount: number;
  readonly price_currency: string;
  readonly is_archived: boolean;
};

const isFixedPrice = (price: VendorPrice): price is VendorPrice & FixedPrice =>
  "price_amount" in price;

type MeteredPrice = {
  readonly id: string;
  readonly meter_id: string;
  readonly unit_amount: string;
  readonly price_currency: string;
  readonly is_archived: boolean;
};

const isMeteredPrice = (price: VendorPrice): price is VendorPrice & MeteredPrice =>
  "meter_id" in price && "unit_amount" in price;

const intervalOf = (interval: Price["interval"]): Polar.RecurringInterval =>
  interval === "annual" ? "year" : "month";

const catalogIntervalOf = (product: VendorProduct): Price["interval"] =>
  product.recurring_interval === "year" ? "annual" : "month";

const kindOf = (product: VendorProduct): TierKind =>
  product.is_recurring ? "subscription" : "one_off";

/** Polar metadata values may be numbers or booleans; ownership is strings. */
const metadataOf = (product: VendorProduct): Record<string, string> =>
  Object.fromEntries(
    Object.entries(product.metadata).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const tierOf = (product: VendorProduct): string => metadataOf(product)[PAYKIT_TIER] ?? "";

const attrsOf = (product: VendorProduct): Product["Attributes"] => {
  const price = product.prices.filter(isFixedPrice).find((candidate) => !candidate.is_archived);
  return {
    id: product.id,
    name: product.name,
    tier: tierOf(product),
    kind: kindOf(product),
    priceId: price?.id ?? "",
    price: {
      amount: price?.price_amount ?? 0,
      currency: price?.price_currency ?? "",
      interval: catalogIntervalOf(product),
    },
    usage: product.prices
      .filter(isMeteredPrice)
      .filter((candidate) => !candidate.is_archived)
      .map((candidate) => ({
        meterId: candidate.meter_id,
        unitPrice: {
          amount: Number(candidate.unit_amount),
          currency: candidate.price_currency,
        },
      })),
    archived: product.is_archived,
    createdAt: product.created_at,
  };
};

/** The meters a product should embed; a one-time product cannot carry one. */
const desiredUsage = (news: ProductProps): ReadonlyArray<ProductUsage> =>
  news.kind === "one_off" ? [] : (news.usage ?? []);

const sameUsage = (
  left: ReadonlyArray<ProductUsage>,
  right: ReadonlyArray<ProductUsage>,
): boolean =>
  left.length === right.length &&
  left.every((candidate) =>
    right.some(
      (other) =>
        other.meterId === candidate.meterId &&
        other.unitPrice.amount === candidate.unitPrice.amount &&
        other.unitPrice.currency === candidate.unitPrice.currency,
    ),
  );

const samePrice = (left: Price, right: Price, kind: TierKind = "subscription"): boolean =>
  left.amount === right.amount &&
  left.currency === right.currency &&
  // A one-off pack's cadence is meaningless: the product is charged once, so a
  // catalog interval change is not a price change.
  (kind === "one_off" || left.interval === right.interval);

/** A price change is a replacement, not an in-place edit; an archived product never returns. */
const shouldReplace = (news: ProductProps, output: Product["Attributes"] | undefined): boolean => {
  if (output === undefined) return false;
  if (output.archived) return true;
  if (news.tier !== output.tier) return true;
  if ((news.kind ?? "subscription") !== output.kind) return true;
  if (!sameUsage(desiredUsage(news), output.usage ?? [])) return true;
  return !samePrice(news.price, output.price, output.kind);
};

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

const listAll = Effect.fn(function* () {
  const products: VendorProduct[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const listed = yield* Polar.productsList({ limit: LIST_PAGE_SIZE, page });
    products.push(...listed.items);
    if (page >= listed.pagination.max_page || listed.items.length === 0) break;
  }
  return products;
});

/** Every generation of one tier's product, newest first. */
const generationsOf = Effect.fn(function* (stage: string, tier: string) {
  const name = productNameOf(stage, tier);
  // The name carries the stage and the metadata carries the tier. Both must
  // match, so a product from another stage is never adopted.
  const matches = (yield* listAll()).filter(
    (product) => product.name === name && tierOf(product) === tier,
  );
  // A price change creates a new generation; the newest wins when state is lost.
  matches.sort((left, right) => right.created_at.localeCompare(left.created_at));
  return matches;
});

const findByTier = Effect.fn(function* (stage: string, tier: string) {
  return (yield* generationsOf(stage, tier)).find((product) => !product.is_archived);
});

/**
 * The newest generation already carrying `price`. A create that outlived its
 * state write leaves exactly this, and adopting it is what makes a retried
 * reconciliation converge instead of creating a duplicate product.
 */
const findByTierAndPrice = Effect.fn(function* (stage: string, tier: string, news: ProductProps) {
  return (yield* generationsOf(stage, tier)).find((product) => {
    if (product.is_archived) return false;
    const attrs = attrsOf(product);
    return (
      samePrice(attrs.price, news.price, kindOf(product)) &&
      sameUsage(desiredUsage(news), attrs.usage)
    );
  });
});

const getById = (id: string) =>
  Polar.productsGet({ id }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const observe = Effect.fn(function* (input: { id?: string; stage: string; tier: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByTier(input.stage, input.tier);
});

const desiredMetadata = Effect.fn(function* (id: string, tier: string) {
  return {
    [PAYKIT_TIER]: tier,
    ...(yield* createInternalMetadata(id)),
  };
});

export const ProductProvider = () =>
  Provider.succeed(Product, {
    stables: ["id", "createdAt"],
    // A product is financial history; `PolarPrices` declares every one with
    // `RemovalPolicy.retain`, and nuke must not try to delete one either.
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const stage = yield* Stage;
      const existing = yield* observe({
        id: output?.id,
        stage,
        tier: output?.tier ?? olds.tier,
      });
      if (existing === undefined) return undefined;
      const attrs = attrsOf(existing);
      return (yield* hasAlchemyMetadata(id, metadataOf(existing))) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const products = (yield* listAll()).filter((product) => !product.is_archived);
      return products
        .filter((product) => metadataOf(product)[alchemyMetadataKeys.stack] !== undefined)
        .map(attrsOf);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const stage = yield* Stage;
      const desiredName = productNameOf(stage, news.tier);
      const desiredDescription = news.description ?? "";
      const metadata = yield* desiredMetadata(id, news.tier);

      let current = yield* observe({ id: output?.id, stage, tier: news.tier });
      // A previous generation (same logical id, a different price) must not be
      // updated in place: Polar embeds the price in the product. A retry after
      // a create that never reached state finds the generation it made.
      if (current === undefined || shouldReplace(news, attrsOf(current))) {
        current = yield* findByTierAndPrice(stage, news.tier, news);
      }

      if (current === undefined) {
        current = yield* Polar.productsCreate({
          body: {
            name: desiredName,
            metadata,
            // A pack is a one-time product: no interval, and the fixed price is
            // charged once. A subscription carries the catalog's cadence.
            ...(news.kind === "one_off"
              ? {}
              : { recurring_interval: intervalOf(news.price.interval) }),
            prices: [
              {
                amount_type: "fixed",
                price_amount: news.price.amount,
                price_currency: news.price.currency,
              },
              ...desiredUsage(news).map((usage) => ({
                amount_type: "metered_unit",
                meter_id: usage.meterId,
                unit_amount: usage.unitPrice.amount,
                price_currency: usage.unitPrice.currency,
              })),
            ],
            ...(desiredDescription.length > 0 ? { description: desiredDescription } : {}),
          },
        });
      }

      const observedMetadata = metadataOf(current);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const nameChanged = current.name !== desiredName;
      const descriptionChanged = (current.description ?? "") !== desiredDescription;

      if (!nameChanged && !descriptionChanged && !metadataChanged) {
        return attrsOf(current);
      }

      const updated = yield* Polar.productsUpdate({
        id: current.id,
        ...(nameChanged ? { name: desiredName } : {}),
        ...(descriptionChanged
          ? { description: desiredDescription.length > 0 ? desiredDescription : null }
          : {}),
        ...(metadataChanged ? { metadata } : {}),
      });
      return attrsOf(updated);
    }),

    // Retention, not archival. A product an order references is financial
    // history, so delete is a no-op and a retired product is left purchasable
    // by the reconcile — `RetiredProducts` is the separate sweep that archives
    // what the catalog stopped declaring.
    delete: () => Effect.void,
  });
