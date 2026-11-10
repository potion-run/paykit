import * as PolarSdk from "@distilled.cloud/polar";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Meter, MeterProvider } from "./Meter.ts";
import type { PolarServer } from "./Polar.ts";
import { POLAR_BASE_URL } from "./PolarClient.ts";
import { Product, ProductProvider } from "./Product.ts";
import { WebhookEndpoint, WebhookEndpointProvider } from "./WebhookEndpoint.ts";

/** The provider collection a stack mounts to reconcile Polar resources. */
export class Providers extends Provider.ProviderCollection<Providers>()("Polar") {}

/** Where the deploy finds Polar, and as which server. */
export interface PolarProvidersProps {
  /** The Polar access token. Redacted, because it is a secret. */
  readonly accessToken: Redacted.Redacted<string> | string;
  /** Which Polar this token belongs to. Defaults to `production`. */
  readonly server?: PolarServer;
  /** Override the API base URL, for a proxy or a local Polar. */
  readonly baseUrl?: string;
}

/**
 * Register the Polar provider a stack needs to reconcile `PolarPrices`.
 *
 * A deployment writes the token once, beside its other providers:
 *
 * ```typescript
 * export default Alchemy.Stack("App", {
 *   providers: Layer.mergeAll(polarProviders({ accessToken }), Cloudflare.providers()),
 *   state: Alchemy.localState(),
 * }, program);
 * ```
 *
 * @primitive
 * @layer
 */
export const polarProviders = (props: PolarProvidersProps) => {
  const accessToken =
    typeof props.accessToken === "string" ? Redacted.make(props.accessToken) : props.accessToken;

  const apiBaseUrl = props.baseUrl ?? POLAR_BASE_URL[props.server ?? "production"];

  return Layer.effect(Providers, Provider.collection([WebhookEndpoint, Meter, Product])).pipe(
    Layer.provide(WebhookEndpointProvider()),
    Layer.provide(MeterProvider()),
    Layer.provide(ProductProvider()),
    Layer.provideMerge(
      Layer.mergeAll(
        PolarSdk.fromApiKey({ apiKey: accessToken, apiBaseUrl }),
        PolarSdk.PolarProtocol,
        FetchHttpClient.layer,
      ),
    ),
  );
};
