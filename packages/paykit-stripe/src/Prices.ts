import * as Stripe from "@alchemy.run/stripe";
import {
  encodeVendorPart,
  type Price,
  type TierId,
  type TierKind,
  type UnitPrice,
} from "@potion.run/paykit";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";

/**
 * One metered price the catalog states: the billable unit price, the Stripe
 * meter that aggregates the units, and the two vendor identities derived from
 * the tier and feature.
 */
export interface UsagePriceDeclaration {
  /** The catalog feature the meter counts. */
  readonly feature: string;
  /** What one billable unit costs, in minor units. */
  readonly unitPrice: UnitPrice;
  /** Logical id of the `BillingMeter` resource. */
  readonly meterResource: string;
  /** Logical id of the metered `Price` resource. */
  readonly priceResource: string;
  /** The meter event name, `paykit_<encoded stage>_<encoded feature>`. */
  readonly eventName: string;
  /** The lookup key for the metered price, `paykit:<stage>:<tier>:usage:<feature>`. */
  readonly lookupKey: string;
}

/**
 * One price the catalog states, and the vendor identities derived from it.
 *
 * Pure, so the mapping is testable without a network: the ids and the lookup
 * key are conventions, and a convention deserves a test rather than a deploy.
 */
export interface PriceDeclaration {
  /** The tier the price belongs to, and the key of the returned map. */
  readonly tier: string;
  /** A subscription repeats; a one-off pack is a single payment. */
  readonly kind: TierKind;
  /** Logical id of the product resource, and of the price resource. */
  readonly productResource: string;
  readonly priceResource: string;
  /** `paykit:<encoded stage>:<encoded tier>` — findable after a restore, per environment. */
  readonly lookupKey: string;
  readonly amount: number;
  readonly currency: string;
  /** The catalog's `month | annual`, in Stripe's spelling. */
  readonly interval: "month" | "year";
  /** One metered price per billable feature, ordered by feature id. */
  readonly usage: ReadonlyArray<UsagePriceDeclaration>;
}

/** A tier's price, optionally with the kind that says how it is sold and its meters. */
export type TierPrice =
  | Price
  | {
      readonly price: Price;
      readonly kind?: TierKind;
      /**
       * One unit price per billable feature. `StripePrices` creates a meter and
       * a metered price for each; a one-off pack has none, because Stripe does
       * not attach metered prices to a one-time price.
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

export const lookupKeyOf = (stage: string, tier: string): string =>
  `paykit:${encodeVendorPart(stage)}:${encodeVendorPart(tier)}`;

/**
 * The lookup key of one tier's metered price for a feature. A tier may price
 * the same feature differently, so the key carries both; the meter itself is
 * per feature and shared by every tier.
 */
export const meteredLookupKeyOf = (stage: string, tier: string, feature: string): string =>
  `paykit:${encodeVendorPart(stage)}:${encodeVendorPart(tier)}:usage:${encodeVendorPart(feature)}`;

/**
 * The meter event name for a feature. Stripe keeps event names unique per
 * account (and reserves a deactivated meter's name), so the stage is in the
 * name for the same reason it is in the lookup key: stages share one account.
 */
export const meterEventNameOf = (stage: string, feature: string): string =>
  `paykit_${encodeVendorPart(stage)}_${encodeVendorPart(feature)}`;

/**
 * The prefix every lookup key this stage owns starts with. `paykit` is the
 * library's, the stage is what keeps two stacks in one Stripe account apart, and
 * the trailing colon is what stops `prod` from matching `production`.
 */
export const lookupKeyPrefixOf = (stage: string): string => `paykit:${encodeVendorPart(stage)}:`;

/** A price the vendor holds, reduced to what the sweep decides on. */
export interface FoundPrice {
  readonly id: string;
  readonly lookupKey: string | null;
  readonly active: boolean;
}

/** Every lookup key the catalog currently sells: the base prices and the metered ones. */
export const declaredLookupKeys = (
  declarations: ReadonlyArray<PriceDeclaration>,
): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const declaration of declarations) {
    keys.add(declaration.lookupKey);
    for (const usage of declaration.usage) keys.add(usage.lookupKey);
  }
  return keys;
};

/**
 * The prices this stage owns that the catalog no longer declares, and that are
 * still active.
 *
 * A retired tier or a dropped `usage` feature leaves its vendor price behind:
 * every resource is declared with `RemovalPolicy.retain`, which is what keeps a
 * bill you already sent reproducible. What it does not do is stop the price
 * being sellable, because a Stripe price that is merely detached from a stack is
 * still `active: true`. This is the half that says which ones to archive.
 *
 * Pure, so the decision is testable without a Stripe account: everything it
 * needs is the catalog's declarations and the prices the account holds.
 */
export const retiredPrices = (
  declarations: ReadonlyArray<PriceDeclaration>,
  found: ReadonlyArray<FoundPrice>,
  stage: string,
): ReadonlyArray<FoundPrice> => {
  const prefix = lookupKeyPrefixOf(stage);
  const declared = declaredLookupKeys(declarations);
  return found.filter(
    (price) =>
      price.active &&
      price.lookupKey !== null &&
      price.lookupKey.startsWith(prefix) &&
      // A price of another stage is still ours, and still not this stack's to
      // archive.
      !declared.has(price.lookupKey),
  );
};

/** Stripe spells the annual interval `year`; the catalog says `annual`. */
const intervalOf = (interval: Price["interval"]): "month" | "year" =>
  interval === "annual" ? "year" : "month";

/**
 * Turn the catalog's prices into the declarations `StripePrices` reconciles.
 * Ordered by tier id and then feature id, so a deploy produces the same
 * resources in the same order however the catalog was written.
 */
export const priceDeclarations = (
  tiers: Readonly<Record<string, TierPrice>>,
  stage: string,
): ReadonlyArray<PriceDeclaration> =>
  Object.entries(tiers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tier, value]) => {
      const { price, kind, usage } = normalize(value);
      return {
        tier,
        kind,
        productResource: `Product_${tier}`,
        priceResource: `Price_${tier}`,
        lookupKey: lookupKeyOf(stage, tier),
        amount: price.amount,
        currency: price.currency,
        interval: intervalOf(price.interval),
        // Charging a one-time price per metered unit is not a thing Stripe
        // models, so a pack never declares a meter.
        usage:
          kind === "one_off"
            ? []
            : Object.entries(usage)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([feature, unitPrice]) => ({
                  feature,
                  unitPrice,
                  meterResource: `Meter_${feature}`,
                  priceResource: `Price_${tier}_Usage_${feature}`,
                  eventName: meterEventNameOf(stage, feature),
                  lookupKey: meteredLookupKeyOf(stage, tier, feature),
                })),
      };
    });

/**
 * What a stack gets back from `StripePrices`: the base price per tier, the
 * metered price per tier and feature, and the meter event name per feature.
 * The event name is what `Stripe({ meters })` needs to report usage later.
 */
export interface SoldPrices {
  /** tier → base price lookup key */
  readonly prices: Readonly<Record<string, string>>;
  /** tier → feature → metered price lookup key */
  readonly usage: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** feature → meter event name */
  readonly meters: Readonly<Record<string, string>>;
}

/** The old single-price handle, kept as a name for a caller that reads the map. */
export type SoldPrice = string;

/**
 * The price resources a tier is sold through, reconciled from the catalog.
 *
 * Yielding this inside a stack creates, replaces and retires Stripe prices:
 *
 * - **create** when no price carries the tier's lookup key;
 * - **create a meter and a metered price** for every `usage` feature, from the
 *   same `unitPrice` the catalog states, so the vendor invoice and the local
 *   ledger use one number;
 * - **replace** when the amount, currency or interval changes: those props are
 *   create-only, so Alchemy creates a new price and moves the lookup key onto it
 *   (`transfer_lookup_key`), because Stripe prices are immutable and a live
 *   subscription must not change what it is charged;
 * - **sell as a one-time price** when the tier is `kind: "one_off"`: no
 *   recurring interval is sent, so checkout can use `mode=payment` instead of
 *   starting a subscription;
 * - **retire** when a tier leaves the catalog: every resource is declared with
 *   `RemovalPolicy.retain`, so the price and meter are left in place and only
 *   Alchemy's state row goes away.
 *
 * The vendor resources are `@alchemy.run/stripe`'s own, so ownership metadata,
 * adoption and drift are the vendor package's problem, not a second
 * implementation's.
 *
 * ### Selling tiers
 * **Example:** A stack that creates the prices its catalog states
 * ```typescript
 * const sold = yield* StripePrices("Prices", {
 *   tiers: {
 *     pro: {
 *       price: proPrice,
 *       usage: { messages: { amount: 2, currency: "usd" } },
 *     },
 *   },
 * });
 *
 * const stripe = Stripe({
 *   secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
 *   origin: "https://app.example.com",
 *   tiers: {
 *     pro: {
 *       price: proPrice,
 *       lookupKey: sold.prices.pro,
 *       usage: {
 *         messages: {
 *           unitPrice: { amount: 2, currency: "usd" },
 *           lookupKey: sold.usage.pro.messages,
 *         },
 *       },
 *     },
 *   },
 *   meters: sold.meters,
 * });
 * ```
 *
 * @primitive
 * @product Stripe
 */
export const StripePrices = Effect.fn("Stripe.Prices")(function* (
  id: string,
  props: { readonly tiers: Readonly<Record<string, TierPrice>> },
) {
  const stack = yield* Stack;
  const declarations = priceDeclarations(props.tiers, stack.stage);
  const prices: Record<string, string> = {};
  const usage: Record<string, Record<string, string>> = {};
  const meters: Record<string, string> = {};

  // One meter per feature, not per tier: a feature is one thing the customer
  // does, however many tiers price it differently.
  const features = [
    ...new Set(declarations.flatMap((declaration) => declaration.usage.map((u) => u.feature))),
  ].sort((left, right) => left.localeCompare(right));
  const createdMeters = new Map<string, Stripe.BillingMeter>();
  for (const feature of features) {
    const eventName = meterEventNameOf(stack.stage, feature);
    const meter = yield* Stripe.BillingMeter(`${id}Meter_${feature}`, {
      displayName: eventName,
      eventName,
      defaultAggregation: { formula: "sum" },
      customerMapping: { type: "by_id", eventPayloadKey: "stripe_customer_id" },
      valueSettings: { eventPayloadKey: "value" },
    }).pipe(RemovalPolicy.retain());
    createdMeters.set(feature, meter);
    meters[feature] = eventName;
  }

  for (const declaration of declarations) {
    // One product per tier: a name an operator can read in the dashboard, and
    // the tier id in metadata so it can be found again.
    const product = yield* Stripe.Product(`${id}${declaration.productResource}`, {
      name: declaration.tier,
      metadata: { paykit_tier: declaration.tier },
    }).pipe(RemovalPolicy.retain());
    // One base price per tier, found by its lookup key, retained when the
    // catalog moves on.
    yield* Stripe.Price(`${id}${declaration.priceResource}`, {
      product,
      currency: declaration.currency,
      unitAmount: declaration.amount,
      // A one-off pack has no recurring price; Stripe rejects `mode=payment`
      // for one, and a subscription cannot use the other.
      ...(declaration.kind === "one_off" ? {} : { recurring: { interval: declaration.interval } }),
      lookupKey: declaration.lookupKey,
    }).pipe(RemovalPolicy.retain());
    prices[declaration.tier] = declaration.lookupKey;

    const metered: Record<string, string> = {};
    for (const price of declaration.usage) {
      const meter = createdMeters.get(price.feature)!;
      yield* Stripe.Price(`${id}${price.priceResource}`, {
        product,
        currency: price.unitPrice.currency,
        unitAmount: price.unitPrice.amount,
        recurring: {
          interval: declaration.interval,
          usageType: "metered",
          meter: meter.id,
        },
        lookupKey: price.lookupKey,
      }).pipe(RemovalPolicy.retain());
      metered[price.feature] = price.lookupKey;
    }
    usage[declaration.tier] = metered;
  }

  return { prices, usage, meters } as SoldPrices;
});

/** The tier id a declaration was built from, narrowed for a caller that reads it back. */
export const tierOfDeclaration = (declaration: PriceDeclaration): TierId =>
  declaration.tier as TierId;
