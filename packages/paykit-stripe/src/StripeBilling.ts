import type { WebhookEndpoint } from "@alchemy.run/stripe";
import type { MoneyProvider } from "@potion.run/paykit";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StripePrices, soldTiers, type SoldPrices, type TierPrice } from "./Prices.ts";
import { Stripe, type StripeProps } from "./Stripe.ts";
import {
  DEFAULT_WEBHOOK_PATH,
  StripeWebhookSecretMissing,
  stripeWebhookEndpoint,
} from "./WebhookEndpoint.ts";

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
  /**
   * Where Stripe posts deliveries, appended to `origin`. Defaults to
   * `/webhooks/stripe`.
   *
   * Ignored when `webhookSecret` is given: that endpoint is managed by hand, so
   * the deploy creates none.
   */
  readonly webhookPath?: string;
};

/** The delivery destination the deploy reconciled, and the secret it minted. */
export interface StripeBillingWebhook {
  /**
   * The endpoint this deploy reconciled. Absent when `webhookSecret` was
   * supplied and the endpoint is managed by hand.
   */
  readonly resource: WebhookEndpoint | undefined;
  /**
   * The signing secret the Worker verifies deliveries with.
   *
   * An `Output` either way: the secret exists only once the endpoint applies, so
   * the deploy evaluates it when it fills the Worker's environment, and the
   * provider's decoder evaluates it when a delivery is verified. A supplied
   * secret is lifted with `Output.literal`, so a caller reads one shape.
   */
  readonly secret: Output.Output<Redacted.Redacted<string>, never>;
}

/** The provider `StripeBilling` returns, with the keys and endpoint it created. */
export interface StripeBillingProvider extends MoneyProvider<"processor"> {
  /** The lookup keys and meter names the deploy created, for a console or a test. */
  readonly sold: SoldPrices;
  /**
   * The delivery destination. The secret is always present — given when the
   * endpoint is managed by hand, minted here when the deploy owns it — because
   * the provider's webhook decoder needs it either way.
   */
  readonly webhookEndpoint: StripeBillingWebhook;
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
 * When `webhookSecret` is omitted, the deploy also reconciles the
 * `WebhookEndpoint` at `origin + webhookPath` and carries the secret Stripe
 * mints at create to the provider as an `Output`. The secret is the one the
 * Worker verifies with: `webhookEndpoint.secret` is what a deploy installs in
 * the Worker's environment, and neither side reads it before the endpoint
 * exists. Supplying `webhookSecret` keeps the endpoint managed by hand, exactly
 * as before, and creates nothing.
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
 * // The Worker receives `stripe.webhookEndpoint.secret` as an Output, minted by
 * // the endpoint this call created at https://app.example.com/webhooks/stripe.
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
  const { webhookPath, webhookSecret, ...stripeProps } = props;

  const providerOf = (
    secret: Redacted.Redacted<string> | Output.Output<Redacted.Redacted<string>, never>,
  ) =>
    Stripe({
      ...stripeProps,
      tiers: soldTiers(props.tiers, sold),
      meters: sold.meters,
      webhookSecret: secret,
    });

  // A supplied secret means a hand-managed endpoint: today's behavior, no
  // resource created and nothing to reconcile.
  if (webhookSecret !== undefined) {
    const managedSecret = Output.isOutput(webhookSecret)
      ? webhookSecret
      : Output.literal(webhookSecret);

    return Object.assign(providerOf(webhookSecret), {
      sold,
      webhookEndpoint: { resource: undefined, secret: managedSecret },
    }) satisfies StripeBillingProvider;
  }

  // The endpoint depends on the app's origin, which a stack may resolve later,
  // so the URL stays an Output until the deploy resolves it.
  const endpoint = yield* stripeWebhookEndpoint(`${id}WebhookEndpoint`, {
    url: Output.interpolate`${props.origin}${webhookPath ?? DEFAULT_WEBHOOK_PATH}`,
  });

  // The stack program has no resolve context, so the secret stays an Output
  // until the deploy evaluates it (the Worker environment, the decoder). A
  // missing one dies with the tagged error rather than storing a redaction
  // nothing can verify with.
  const secret = Output.all(endpoint.secret, endpoint.id).pipe(
    Output.mapEffect(([value, endpointId]) =>
      value === undefined
        ? Effect.fail(new StripeWebhookSecretMissing({ endpoint: endpointId })).pipe(Effect.orDie)
        : Effect.succeed(value),
    ),
  );

  return Object.assign(providerOf(secret), {
    sold,
    webhookEndpoint: { resource: endpoint, secret },
  }) satisfies StripeBillingProvider;
});
