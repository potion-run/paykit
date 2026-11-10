import {
  asPricing,
  soleUnitPriceOf,
  unitsOf,
  type PolarTier,
  type Price,
  type Pricing,
  type PricingValue,
  type PlanKind,
  type UnitPrice,
} from "@potion.run/paykit";
import type { Output } from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { Meter, meterEventNameOf } from "./Meter.ts";
import { Product, productNameOf, productNamePrefixOf } from "./Product.ts";

export { productNameOf };

/**
 * The prefix every product name this stage owns starts with, re-exported
 * beside the name it completes so a sweep and a deploy read one convention.
 */
export { productNamePrefixOf };

/** One meter a tier's usage is priced through. */
export interface ProductUsageDeclaration {
  /** The catalog feature the meter counts. */
  readonly feature: string;
  /** What one billable unit costs, in minor units, when the pricing has one rate. */
  readonly unitPrice?: UnitPrice;
  /** The full pricing when it is a band ladder and has no single rate. */
  readonly pricing?: Pricing;
  /** Logical id of the `Meter` resource. */
  readonly meterResource: string;
  /** The meter event name, `paykit_<encoded stage>_<encoded feature>`. */
  readonly eventName: string;
}

/**
 * One product the catalog states. Pure, so the convention is testable without
 * a network: the name, the metadata and the price are all derived here.
 */
export interface ProductDeclaration {
  /** The tier the product belongs to, and the key of the returned map. */
  readonly tier: string;
  /** A subscription repeats; a one-off pack is a single payment. */
  readonly kind: PlanKind;
  /** Logical id of the product resource. */
  readonly productResource: string;
  /** `paykit:<stage>:<tier>` — the name, which carries the stage. */
  readonly name: string;
  /** The catalog's price, embedded in the product. */
  readonly price: Price;
  /** One metered price per billable feature, ordered by feature id. */
  readonly usage: ReadonlyArray<ProductUsageDeclaration>;
  /** One seat-based price per non-consumable feature, ordered by feature id. */
  readonly seats: ReadonlyArray<{ readonly feature: string; readonly unitPrice: UnitPrice }>;
}

/** A tier's price, optionally with the kind that says how it is sold and its meters. */
export type TierPrice =
  | Price
  | {
      readonly price: Price;
      readonly kind?: PlanKind;
      /**
       * One unit price per billable feature. Polar embeds a metered price in
       * the product, so a change to any unit price is a new product.
       */
      readonly usage?: Readonly<Record<string, PricingValue>>;
      /** One per-seat price per non-consumable feature. */
      readonly seats?: Readonly<Record<string, UnitPrice>>;
    };

const normalize = (
  value: TierPrice,
): {
  readonly price: Price;
  readonly kind: PlanKind;
  readonly usage: Readonly<Record<string, PricingValue>>;
  readonly seats: Readonly<Record<string, UnitPrice>>;
} =>
  "price" in value
    ? {
        price: value.price,
        kind: value.kind ?? "subscription",
        usage: value.usage ?? {},
        seats: value.seats ?? {},
      }
    : { price: value, kind: "subscription", usage: {}, seats: {} };

/**
 * Turn the catalog's prices into the declarations `PolarPrices` reconciles.
 * Ordered by tier id and then feature id, so a deploy produces the same
 * resources in the same order however the catalog was written.
 */
export const priceDeclarations = (
  tiers: Readonly<Record<string, TierPrice>>,
  stage: string,
): ReadonlyArray<ProductDeclaration> =>
  Object.entries(tiers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tier, value]) => {
      const { price, kind, usage, seats } = normalize(value);

      return {
        tier,
        kind,
        productResource: `Product_${tier}`,
        // Polar has no lookup key. The name carries the stage; the metadata
        // carries the tier, and together they are the identity a restored state
        // reconciles to.
        name: productNameOf(stage, tier),
        price,
        // A one-time product cannot carry a metered price, and a pack has no
        // postpaid allowance to price.
        usage:
          kind === "one_off"
            ? []
            : Object.entries(usage)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([feature, value]) => {
                  const pricing = asPricing(value);
                  const unitPrice = soleUnitPriceOf(pricing);
                  const keepsPricing = unitPrice === null || unitsOf(unitPrice) > 1;

                  return {
                    feature,
                    ...(unitPrice === null ? {} : { unitPrice }),
                    ...(keepsPricing ? { pricing } : {}),
                    meterResource: `Meter_${feature}`,
                    eventName: meterEventNameOf(stage, feature),
                  };
                }),
        seats:
          kind === "one_off"
            ? []
            : Object.entries(seats)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([feature, unitPrice]) => ({ feature, unitPrice })),
      };
    });

/** A product the vendor holds, reduced to what the sweep decides on. */
export interface FoundProduct {
  /** The Polar product id the tier is sold as. Its form is Polar's. */
  readonly id: string;
  /** The stage-qualified name, `paykit:<encoded stage>:<encoded tier>`. */
  readonly name: string;
  /** `metadata.paykit_tier`, or `null` when the product carries none. */
  readonly tier: string | null;
  /** Whether Polar has archived the product. */
  readonly archived: boolean;
}

/** Every name the catalog currently sells. Polar has no lookup key, so the name is the key. */
export const declaredProductNames = (
  declarations: ReadonlyArray<ProductDeclaration>,
): ReadonlySet<string> => new Set(declarations.map((declaration) => declaration.name));

/**
 * The products this stage owns that the catalog no longer declares, and that
 * Polar still offers for sale.
 *
 * A retired tier leaves its product behind: every resource is declared with
 * `RemovalPolicy.retain`, which is what keeps a bill you already sent
 * reproducible. What it does not do is stop the product being buyable, because
 * a Polar product detached from a stack is still purchasable. This is the half
 * that says which ones to archive.
 *
 * The identity is the pair `PolarPrices` writes: the stage-qualified name *and*
 * `metadata.paykit_tier`. Both are required here, so a product someone created
 * by hand under a name that happens to start with ours is not swept away, and
 * the prefix keeps one stage's sweep out of another's catalog.
 *
 * Pure, so the decision is testable without a Polar organization: everything it
 * needs is the catalog's declarations and the products the vendor holds.
 */
export const retiredProducts = (
  declarations: ReadonlyArray<ProductDeclaration>,
  found: ReadonlyArray<FoundProduct>,
  stage: string,
): ReadonlyArray<FoundProduct> => {
  const prefix = productNamePrefixOf(stage);
  const declared = declaredProductNames(declarations);

  return found.filter(
    (product) =>
      !product.archived &&
      product.tier !== null &&
      product.name.startsWith(prefix) &&
      // A product of another stage is still ours, and still not this stack's
      // to archive.
      !declared.has(product.name),
  );
};

/** What a stack gets back: the Polar product id a tier is sold as. */
export type SoldProduct = Output<string>;

/**
 * What `PolarPrices` returns. `meters` is the feature → event name map
 * `Polar({ meters })` needs at runtime to report a closing period's usage.
 */
export interface SoldPrices {
  /** tier → the Polar product id the tier is sold as. */
  readonly products: Readonly<Record<string, SoldProduct>>;
  /** feature → the meter event name usage is ingested under. */
  readonly meters: Readonly<Record<string, string>>;
  /** tier → feature → the per-seat price the product carries. */
  readonly seats: Readonly<Record<string, Readonly<Record<string, UnitPrice>>>>;
}

/**
 * The `Polar({ tiers })` map for a set of catalog prices and the products
 * `PolarPrices` created for them.
 *
 * Pure, so the join is testable without a Polar organization. A Polar product
 * id is an `Output<string>` because Polar mints it, so the handle is passed
 * through unchanged: `Polar()` resolves it when a checkout or a webhook needs
 * it, after the deploy has created the product.
 */
export const soldTiers = (
  tiers: Readonly<Record<string, TierPrice>>,
  sold: SoldPrices,
): Readonly<Record<string, PolarTier>> =>
  Object.fromEntries(
    Object.entries(tiers).map(([tier, value]) => {
      const { price, kind, usage, seats } = normalize(value);

      return [
        tier,
        {
          price,
          // The product map and the tier map come from the same declaration,
          // so a missing id is a deploy bug, not a runtime fallback.
          productId: sold.products[tier]!,
          // A one-time product cannot carry a metered or a per-seat price, and
          // `PolarPrices` did not create one for it.
          ...(kind === "one_off" || Object.keys(usage).length === 0 ? {} : { usage }),
          ...(kind === "one_off" || Object.keys(seats).length === 0 ? {} : { seats }),
        },
      ];
    }),
  );

/**
 * The Polar products a tier is sold through, reconciled from the catalog.
 *
 * Yielding this inside a stack creates, replaces and retires products:
 *
 * - **create** when no product carries `paykit:<stage>:<tier>` and
 *   `metadata.paykit_tier = "<tier>"`;
 * - **create a meter and a metered price** for every `usage` feature, from the
 *   same `unitPrice` the catalog states, so the vendor invoice and the local
 *   ledger use one number;
 * - **replace** when the amount, currency, interval or a metered unit price
 *   changes: Polar embeds prices in the product, so the product itself is the
 *   price, and the new generation gets a new id while the old one stays in
 *   Polar;
 * - **sell as a one-time product** when the tier is `kind: "one_off"`: the
 *   product has no recurring interval, so checkout is a single payment rather
 *   than a subscription;
 * - **retire** when a tier leaves the catalog: every product and meter is
 *   declared with `RemovalPolicy.retain`, so Polar keeps it and only Alchemy's
 *   state row goes away.
 *
 * ### Selling tiers
 * **Example:** A stack that creates the Polar products its catalog states
 * ```typescript
 * const sold = yield* PolarPrices("Prices", {
 *   tiers: {
 *     pro: {
 *       price: proPrice,
 *       usage: { messages: { amount: 2, currency: "usd" } },
 *     },
 *   },
 * });
 *
 * const polar = Polar({
 *   accessToken: env.POLAR_API_KEY,
 *   origin: "https://app.example.com",
 *   tiers: {
 *     pro: {
 *       price: proPrice,
 *       productId: sold.products.pro,
 *       usage: { messages: { amount: 2, currency: "usd" } },
 *     },
 *   },
 *   meters: sold.meters,
 * });
 * ```
 *
 * @primitive
 * @product Polar
 */
export const PolarPrices = Effect.fn("Polar.Prices")(function* (
  id: string,
  props: { readonly tiers: Readonly<Record<string, TierPrice>> },
) {
  const stack = yield* Stack;
  const declarations = priceDeclarations(props.tiers, stack.stage);
  const products: Record<string, SoldProduct> = {};
  const meters: Record<string, string> = {};
  const seats: Record<string, Record<string, UnitPrice>> = {};

  // One meter per feature, not per tier: a feature is one thing the customer
  // does, however many tiers price it differently.
  const features = [
    ...new Set(declarations.flatMap((declaration) => declaration.usage.map((u) => u.feature))),
  ].sort((left, right) => left.localeCompare(right));

  const createdMeters = new Map<string, Meter>();

  for (const feature of features) {
    const meter = yield* Meter(`${id}Meter_${feature}`, {
      feature,
      eventName: meterEventNameOf(stack.stage, feature),
    }).pipe(RemovalPolicy.retain());

    createdMeters.set(feature, meter);
    meters[feature] = meterEventNameOf(stack.stage, feature);
  }

  for (const declaration of declarations) {
    const product = yield* Product(`${id}${declaration.productResource}`, {
      tier: declaration.tier,
      kind: declaration.kind,
      price: declaration.price,
      usage: declaration.usage.map((usage) => ({
        meterId: createdMeters.get(usage.feature)!.id,
        ...(usage.unitPrice === undefined ? {} : { unitPrice: usage.unitPrice }),
        ...(usage.pricing === undefined ? {} : { pricing: usage.pricing }),
      })),
      seats: declaration.seats.map((seat) => ({ unitPrice: seat.unitPrice })),
    }).pipe(RemovalPolicy.retain());

    products[declaration.tier] = product.id;
    seats[declaration.tier] = Object.fromEntries(
      declaration.seats.map((seat) => [seat.feature, seat.unitPrice]),
    );
  }

  return { products, meters, seats } satisfies SoldPrices;
});
