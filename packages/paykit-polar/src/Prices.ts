import type { Price, TierKind, UnitPrice } from "@potion.run/paykit";
import type { Output } from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { Meter, meterEventNameOf } from "./Meter.ts";
import { Product, productNameOf } from "./Product.ts";

export { productNameOf };

/** One meter a tier's usage is priced through. */
export interface ProductUsageDeclaration {
  /** The catalog feature the meter counts. */
  readonly feature: string;
  /** What one billable unit costs, in minor units. */
  readonly unitPrice: UnitPrice;
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
  readonly kind: TierKind;
  /** Logical id of the product resource. */
  readonly productResource: string;
  /** `paykit:<stage>:<tier>` — the name, which carries the stage. */
  readonly name: string;
  /** The catalog's price, embedded in the product. */
  readonly price: Price;
  /** One metered price per billable feature, ordered by feature id. */
  readonly usage: ReadonlyArray<ProductUsageDeclaration>;
}

/** A tier's price, optionally with the kind that says how it is sold and its meters. */
export type TierPrice =
  | Price
  | {
      readonly price: Price;
      readonly kind?: TierKind;
      /**
       * One unit price per billable feature. Polar embeds a metered price in
       * the product, so a change to any unit price is a new product.
       */
      readonly usage?: Readonly<Record<string, UnitPrice>>;
    };

const normalize = (
  value: TierPrice,
): {
  readonly price: Price;
  readonly kind: TierKind;
  readonly usage: Readonly<Record<string, UnitPrice>>;
} =>
  "price" in value
    ? {
        price: value.price,
        kind: value.kind ?? "subscription",
        usage: value.usage ?? {},
      }
    : { price: value, kind: "subscription", usage: {} };

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
      const { price, kind, usage } = normalize(value);
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
                .map(([feature, unitPrice]) => ({
                  feature,
                  unitPrice,
                  meterResource: `Meter_${feature}`,
                  eventName: meterEventNameOf(stage, feature),
                })),
      };
    });

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
}

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
 *   accessToken: yield* Config.redacted("POLAR_ACCESS_TOKEN"),
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
        unitPrice: usage.unitPrice,
      })),
    }).pipe(RemovalPolicy.retain());
    products[declaration.tier] = product.id;
  }

  return { products, meters } as SoldPrices;
});
