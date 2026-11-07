import type { MoneyProvider } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { Polar, type PolarProps } from "./Polar.ts";
import { PolarPrices, soldTiers, type SoldPrices, type TierPrice } from "./Prices.ts";

/**
 * What `PolarBilling` needs: the Polar props, with the tier map stated as
 * catalog prices rather than the product ids `PolarPrices` returns.
 */
export type PolarBillingProps = Omit<PolarProps, "tiers" | "meters"> & {
  /**
   * Tier → the catalog price, optionally with the kind that says how it is
   * sold and one unit price per billable feature. The deploy creates a
   * product, its fixed and metered prices, and its per-seat prices, then hands
   * the provider the product ids it created.
   */
  readonly tiers: Readonly<Record<string, TierPrice>>;
};

/** The provider `PolarBilling` returns, with the products it created. */
export interface PolarBillingProvider extends MoneyProvider<"merchant_of_record"> {
  /** The product ids, meters and seat prices the deploy created, for a console or a test. */
  readonly sold: SoldPrices;
}

/**
 * Polar provisioning and the Polar provider in one call.
 *
 * `PolarPrices` creates the products, meters and prices the catalog states;
 * `Polar(props)` turns those products into the provider the billing stack
 * validates. A deployment always needs both, and the tier map is the same in
 * both, so this joins them once instead of making the user repeat it.
 *
 * A Polar product id is minted by Polar, so the join cannot be a plain string
 * at declaration time: the provider carries the `Output`s `PolarPrices`
 * returned and resolves one at the moment a checkout or a webhook needs it.
 *
 * The two primitives stay exported: use `PolarPrices` when the provider is
 * configured elsewhere, and `Polar` when the product ids are written by hand.
 *
 * ### Selling a catalog through Polar
 * **Example:** One call, then the billing stack
 * ```typescript
 * const polar = yield* PolarBilling("Polar", {
 *   accessToken: yield* Config.redacted("POLAR_ACCESS_TOKEN"),
 *   origin: "https://app.example.com",
 *   tiers: {
 *     pro: {
 *       price: proPrice,
 *       usage: { messages: { amount: 2, currency: "usd" } },
 *     },
 *   },
 * });
 *
 * yield* Paykit.BillingStack("Billing", { catalog, providers: [polar] });
 * ```
 *
 * @primitive
 * @product Polar
 */
export const PolarBilling = Effect.fn("Polar.Billing")(function* (
  id: string,
  props: PolarBillingProps,
) {
  const sold = yield* PolarPrices(id, { tiers: props.tiers });
  const provider = Polar({
    ...props,
    tiers: soldTiers(props.tiers, sold),
    meters: sold.meters,
  });
  return Object.assign(provider, { sold }) as PolarBillingProvider;
});
