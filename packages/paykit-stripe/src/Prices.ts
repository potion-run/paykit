import * as Stripe from "@alchemy.run/stripe";
import type { Price, TierId } from "@potion.run/paykit";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";

/**
 * One price the catalog states, and the vendor identities derived from it.
 *
 * Pure, so the mapping is testable without a network: the ids and the lookup
 * key are conventions, and a convention deserves a test rather than a deploy.
 */
export interface PriceDeclaration {
  /** The tier the price belongs to, and the key of the returned map. */
  readonly tier: string;
  /** Logical id of the product resource, and of the price resource. */
  readonly productResource: string;
  readonly priceResource: string;
  /** `<stage>:<tier>` under `paykit:` — findable after a restore, per environment. */
  readonly lookupKey: string;
  readonly amount: number;
  readonly currency: string;
  /** The catalog's `month | annual`, in Stripe's spelling. */
  readonly interval: "month" | "year";
}

/**
 * The lookup key a tier's price carries, and the only identity that survives a
 * lost state: a restored database reconciles to the same Stripe price instead of
 * creating a second one.
 *
 * The stage is in the key because a Stripe account is shared by every stage that
 * uses the same key pair. Without it, a `preview` stack's price would take the
 * lookup key from `prod`'s (`transfer_lookup_key` moves it), and the production
 * checkout would start charging the preview amount.
 */
export const lookupKeyOf = (stage: string, tier: string): string => `paykit:${stage}:${tier}`;

/** Stripe spells the annual interval `year`; the catalog says `annual`. */
const intervalOf = (interval: Price["interval"]): "month" | "year" =>
  interval === "annual" ? "year" : "month";

/**
 * Turn the catalog's prices into the declarations `StripePrices` reconciles.
 * Ordered by tier id, so a deploy produces the same resources in the same order
 * however the catalog was written.
 */
export const priceDeclarations = (
  tiers: Readonly<Record<string, Price>>,
  stage: string,
): ReadonlyArray<PriceDeclaration> =>
  Object.entries(tiers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tier, price]) => ({
      tier,
      productResource: `Product_${tier}`,
      priceResource: `Price_${tier}`,
      lookupKey: lookupKeyOf(stage, tier),
      amount: price.amount,
      currency: price.currency,
      interval: intervalOf(price.interval),
    }));

/**
 * What a stack gets back: the lookup key a tier is sold under.
 *
 * The key, not the price id, is what a provider config carries. A price id is
 * an output of one deploy; the key is the identity that survives a restore, a
 * second stage and a replaced price, and the provider resolves it to whichever
 * price currently answers for that tier.
 */
export type SoldPrice = string;

/**
 * The price resources a tier is sold through, reconciled from the catalog.
 *
 * Yielding this inside a stack creates, replaces and retires Stripe prices:
 *
 * - **create** when no price carries the tier's lookup key;
 * - **replace** when the amount, currency or interval changes: those props are
 *   create-only, so Alchemy creates a new price and moves the lookup key onto it
 *   (`transfer_lookup_key`), because Stripe prices are immutable and a live
 *   subscription must not change what it is charged;
 * - **retire** when a tier leaves the catalog: both resources are declared with
 *   `RemovalPolicy.retain`, so the price object is left in place and only
 *   Alchemy's state row goes away. It is not archived — that is a vendor write
 *   against a resource the stack no longer tracks, and it is a follow-up
 *   rather than something this helper pretends to do.
 *
 * The vendor resources are `@alchemy.run/stripe`'s own, so ownership metadata,
 * adoption and drift are the vendor package's problem, not a second
 * implementation's.
 *
 * ### Selling tiers
 * **Example:** A stack that creates the prices its catalog states
 * ```typescript
 * const prices = yield* StripePrices("Prices", {
 *   tiers: { pro: proPrice, scale: scalePrice },
 * });
 *
 * const stripe = Stripe({
 *   secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
 *   origin: "https://app.example.com",
 *   tiers: {
 *     pro: { price: proPrice, priceId: prices.pro.priceId },
 *     scale: { price: scalePrice, priceId: prices.scale.priceId },
 *   },
 * });
 * ```
 *
 * @primitive
 * @product Stripe
 */
export const StripePrices = Effect.fn("Stripe.Prices")(function* (
  id: string,
  props: { readonly tiers: Readonly<Record<string, Price>> },
) {
  const stack = yield* Stack;
  const declarations = priceDeclarations(props.tiers, stack.stage);
  const sold: Record<string, SoldPrice> = {};

  for (const declaration of declarations) {
    // One product per tier: a name an operator can read in the dashboard, and
    // the tier id in metadata so it can be found again.
    const product = yield* Stripe.Product(`${id}${declaration.productResource}`, {
      name: declaration.tier,
      metadata: { paykit_tier: declaration.tier },
    }).pipe(RemovalPolicy.retain());
    // One price per tier, found by its lookup key, archived rather than deleted
    // when the catalog moves on.
    yield* Stripe.Price(`${id}${declaration.priceResource}`, {
      product,
      currency: declaration.currency,
      unitAmount: declaration.amount,
      recurring: { interval: declaration.interval },
      lookupKey: declaration.lookupKey,
    }).pipe(RemovalPolicy.retain());
    sold[declaration.tier] = declaration.lookupKey;
  }

  return sold;
});

/** The tier id a declaration was built from, narrowed for a caller that reads it back. */
export const tierOfDeclaration = (declaration: PriceDeclaration): TierId =>
  declaration.tier as TierId;
