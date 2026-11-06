import type { MoneyProvider } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { StripePrices, soldTiers, type SoldPrices, type TierPrice } from "./Prices.ts";
import { Stripe, type StripeProps } from "./Stripe.ts";

/**
 * What `StripeBilling` needs: the Stripe props, with the tier map stated as
 * catalog prices rather than the lookup keys `StripePrices` returns.
 */
export type StripeBillingProps = Omit<StripeProps, "tiers" | "meters"> & {
  /**
   * Tier → the catalog price and, per billable feature, the unit price. The
   * deploy creates a product, a base price, a meter and a metered price for
   * each, then hands the provider the keys it created.
   */
  readonly tiers: Readonly<Record<string, TierPrice>>;
};

/** The provider `StripeBilling` returns, with the keys it created. */
export interface StripeBillingProvider extends MoneyProvider<"processor"> {
  /** The lookup keys and meter names the deploy created, for a console or a test. */
  readonly sold: SoldPrices;
}

/**
 * Stripe provisioning and the Stripe provider in one call.
 *
 * `StripePrices` creates the products, prices, meters and metered prices the
 * catalog states; `Stripe(props)` turns those keys into the provider the
 * billing stack validates. A deployment always needs both, and the tier map is
 * the same in both, so this joins them once instead of making the user repeat
 * it.
 *
 * The two primitives stay exported: use `StripePrices` when the provider is
 * configured elsewhere, and `Stripe` when the lookup keys are written by hand.
 *
 * ### Selling a catalog through Stripe
 * **Example:** One call, then the billing stack
 * ```typescript
 * const stripe = yield* StripeBilling("Stripe", {
 *   secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
 *   origin: "https://app.example.com",
 *   tiers: {
 *     pro: {
 *       price: proPrice,
 *       usage: { messages: { amount: 2, currency: "usd" } },
 *     },
 *   },
 * });
 *
 * yield* Paykit.BillingStack("Billing", { catalog, providers: [stripe] });
 * ```
 *
 * @primitive
 * @product Stripe
 */
export const StripeBilling = Effect.fn("Stripe.Billing")(function* (
  id: string,
  props: StripeBillingProps,
) {
  const sold = yield* StripePrices(id, { tiers: props.tiers });
  const provider = Stripe({
    ...props,
    tiers: soldTiers(props.tiers, sold),
    meters: sold.meters,
  });
  return Object.assign(provider, { sold }) as StripeBillingProvider;
});
