import type { MoneyProvider } from "@potion.run/paykit";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Polar, type PolarProps } from "./Polar.ts";
import { PolarPrices, soldTiers, type SoldPrices, type TierPrice } from "./Prices.ts";
import {
  DEFAULT_WEBHOOK_PATH,
  polarWebhookEndpoint,
  webhookSecretOrFail,
  type WebhookEndpoint,
} from "./WebhookEndpoint.ts";

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
  /**
   * Where Polar posts deliveries, appended to `origin`. Defaults to
   * `/webhooks/polar`.
   *
   * Ignored when `webhookSecret` is given: that endpoint is managed by hand,
   * so the deploy creates none.
   */
  readonly webhookPath?: string;
};

/** The delivery destination the deploy reconciled, and the secret it minted. */
export interface PolarBillingWebhook {
  /**
   * The endpoint this deploy reconciled. Absent when `webhookSecret` was
   * supplied and the endpoint is managed by hand.
   */
  readonly resource: WebhookEndpoint | undefined;
  /**
   * The signing secret the Worker verifies deliveries with, as an Output. The
   * deploy resolves it when it builds the Worker's environment, exactly like a
   * product id.
   */
  readonly secret: Output.Output<Redacted.Redacted<string>, never>;
}

/** The provider `PolarBilling` returns, with the products and endpoint it created. */
export interface PolarBillingProvider extends MoneyProvider<"merchant_of_record"> {
  /** The product ids, meters and seat prices the deploy created, for a console or a test. */
  readonly sold: SoldPrices;
  /**
   * The delivery destination. The secret is always present — given when the
   * endpoint is managed by hand, minted here when the deploy owns it — because
   * the provider's webhook decoder needs it either way.
   */
  readonly webhookEndpoint: PolarBillingWebhook;
}

/**
 * Polar provisioning and the Polar provider in one call.
 *
 * `PolarPrices` creates the products, meters and prices the catalog states;
 * `Polar(props)` turns those products into the provider the billing stack
 * validates. A deployment always needs both, and the tier map is the same in
 * both, so this joins them once instead of making the user repeat it.
 *
 * When `webhookSecret` is omitted, the deploy also reconciles the
 * `WebhookEndpoint` at `origin + webhookPath` and carries the secret Polar
 * mints at create into the Worker's environment. The secret stays an `Output`
 * because the stack program declares it before Polar has minted it: the
 * returned provider's webhook decoder reads the attribute when a delivery is
 * verified, and a Worker builds its own `Polar` from the environment, where the
 * secret is a plain `Redacted`. Supplying `webhookSecret` keeps the endpoint
 * managed by hand, exactly as before, and creates nothing.
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
 * // The Worker receives `polar.webhookEndpoint.secret`, minted by the endpoint
 * // this call created at https://app.example.com/webhooks/polar.
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
  const { webhookPath, webhookSecret, ...polarProps } = props;

  const providerOf = (
    secret: Redacted.Redacted<string> | Output.Output<Redacted.Redacted<string>, never>,
  ) =>
    Polar({
      ...polarProps,
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
    }) satisfies PolarBillingProvider;
  }

  // The endpoint depends on the app's origin, which a stack may resolve later
  // (a Worker URL), so the URL stays an Output until the deploy resolves it.
  const endpoint = yield* polarWebhookEndpoint(`${id}WebhookEndpoint`, {
    url: Output.interpolate`${props.origin}${webhookPath ?? DEFAULT_WEBHOOK_PATH}`,
  });

  // The stack program has no resolve context, so the secret stays an Output
  // until the deploy evaluates it (the Worker environment, the decoder). A
  // missing one dies with the tagged error rather than storing a redaction
  // nothing can verify with.
  const secret = Output.all(endpoint.secret, endpoint.id, endpoint.url).pipe(
    Output.mapEffect(([value, endpointId, url]) =>
      webhookSecretOrFail({ endpoint: endpointId, url, secret: value }).pipe(Effect.orDie),
    ),
  );

  return Object.assign(providerOf(secret), {
    sold,
    webhookEndpoint: { resource: endpoint, secret },
  }) satisfies PolarBillingProvider;
});
