import type { MoneyProvider } from "@potion.run/paykit";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Credentials } from "./Credentials.ts";
import { Polar, type PolarProps } from "./Polar.ts";
import { PolarPrices, soldTiers, type SoldPrices, type TierPrice } from "./Prices.ts";
import {
  DEFAULT_WEBHOOK_PATH,
  polarWebhookEndpoint,
  webhookSecretOrFail,
  type WebhookEndpoint,
} from "./WebhookEndpoint.ts";

/**
 * A deploy has neither an `accessToken` prop nor a Polar `Credentials` layer in
 * context, so it cannot authenticate to Polar. `polarProviders()` supplies the
 * layer; a caller that builds the provider by hand passes the token.
 */
export class PolarCredentialsMissing extends Schema.TaggedError<PolarCredentialsMissing>()(
  "PolarCredentialsMissing",
  { id: Schema.String },
) {}

/**
 * What `PolarBilling` needs: the Polar props, with the tier map stated as
 * catalog prices rather than the product ids `PolarPrices` returns.
 */
export type PolarBillingProps = Omit<PolarProps, "tiers" | "meters" | "accessToken"> & {
  /**
   * The access token. Omitted, the deploy resolves `POLAR_API_KEY` or the
   * selected profile through the `Credentials` layer `polarProviders()`
   * supplies, exactly as `PolarPrices` does for the resources.
   */
  readonly accessToken?: string;
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
  /**
   * The token the deploy resolved. A Worker's environment receives it, because
   * a Worker has no profile store; a deployment passes it as `POLAR_API_KEY`.
   */
  readonly accessToken: Redacted.Redacted<string>;
}

/** The token and base URL a deploy resolved, from the prop or `Credentials`. */
interface ResolvedPolarCredentials {
  readonly accessToken: Redacted.Redacted<string>;
  readonly apiBaseUrl?: string;
}

/** The token `PolarBilling` and `PolarPrices` share, resolved once per deploy. */
const credentialsOf = Effect.fn("Polar.credentials")(function* (id: string) {
  const credentials = yield* Effect.serviceOption(Credentials);

  if (Option.isNone(credentials)) {
    return yield* new PolarCredentialsMissing({ id });
  }

  const config = yield* credentials.value;

  return {
    accessToken: config.apiKey,
    apiBaseUrl: config.apiBaseUrl,
  } satisfies ResolvedPolarCredentials;
});

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
 * The token is resolved once for both halves. A supplied `accessToken` wins;
 * otherwise the `Credentials` layer `polarProviders()` supplies resolves
 * `POLAR_API_KEY` or the selected `ALCHEMY_PROFILE`. The provider exposes the
 * resolved token as `accessToken`, so a deployment can put it in the Worker's
 * environment, where no profile store exists.
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
 * // The Worker receives `polar.accessToken` and `polar.webhookEndpoint.secret`,
 * // plus the ids in `polar.sold`.
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
  const { webhookPath, webhookSecret, accessToken, ...polarProps } = props;

  // One token for both halves. A supplied prop wins (a test or an embedding);
  // otherwise the Credentials layer `polarProviders()` supplies resolves
  // POLAR_API_KEY or the selected profile, exactly as the resources do.
  const resolved: ResolvedPolarCredentials =
    accessToken === undefined
      ? yield* credentialsOf(id)
      : { accessToken: Redacted.make(accessToken) };

  const providerOf = (
    secret: Redacted.Redacted<string> | Output.Output<Redacted.Redacted<string>, never>,
  ) =>
    Polar({
      ...polarProps,
      // `server` / `baseUrl` are the deployment's choice; the credential's base
      // URL fills in only when the caller states neither.
      ...(props.server === undefined &&
      props.baseUrl === undefined &&
      resolved.apiBaseUrl !== undefined
        ? { baseUrl: resolved.apiBaseUrl }
        : {}),
      accessToken: Redacted.value(resolved.accessToken),
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
      accessToken: resolved.accessToken,
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
    accessToken: resolved.accessToken,
  }) satisfies PolarBillingProvider;
});
