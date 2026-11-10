import * as PolarSdk from "@distilled.cloud/polar";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { PolarAuth } from "./AuthProvider.ts";
import { fromAuthProvider } from "./Credentials.ts";
import { Meter, MeterProvider } from "./Meter.ts";
import type { PolarServer } from "./Polar.ts";
import { POLAR_BASE_URL } from "./PolarClient.ts";
import { Product, ProductProvider } from "./Product.ts";
import { WebhookEndpoint, WebhookEndpointProvider } from "./WebhookEndpoint.ts";

/** The provider collection a stack mounts to reconcile Polar resources. */
export class Providers extends Provider.ProviderCollection<Providers>()("Polar") {}

/** Where the deploy finds Polar, and as which server. */
export interface PolarProvidersProps {
  /**
   * Which Polar the token belongs to. Defaults to the token's own API base
   * URL, which is `production` unless `POLAR_API_BASE_URL` or the profile says
   * otherwise.
   */
  readonly server?: PolarServer;
  /** Override the API base URL, for a proxy or a local Polar. */
  readonly baseUrl?: string;
}

/**
 * Register the Polar provider a stack needs to reconcile `PolarPrices`.
 *
 * The access token is resolved by the Alchemy AuthProvider: `POLAR_API_KEY`
 * from the environment wins, otherwise the profile `ALCHEMY_PROFILE` selects
 * (default `default`). A deployment writes it once, in the environment or in
 * `alchemy profile edit --provider Polar`, beside its other providers:
 *
 * ```typescript
 * export default Alchemy.Stack("App", {
 *   providers: Layer.mergeAll(polarProviders({ server: "sandbox" }), Cloudflare.providers()),
 *   state: Alchemy.localState(),
 * }, program);
 * ```
 *
 * `server` or `baseUrl` is the deployment's choice, not a credential: when one
 * is given it overrides the stored base URL, so a sandbox deploy cannot be
 * pointed at production by a profile.
 *
 * @primitive
 * @layer
 */
export const polarProviders = (props: PolarProvidersProps = {}) => {
  const apiBaseUrl =
    props.baseUrl ?? (props.server === undefined ? undefined : POLAR_BASE_URL[props.server]);

  return Layer.effect(Providers, Provider.collection([WebhookEndpoint, Meter, Product])).pipe(
    Layer.provide(WebhookEndpointProvider()),
    Layer.provide(MeterProvider()),
    Layer.provide(ProductProvider()),
    Layer.provideMerge(fromAuthProvider(apiBaseUrl === undefined ? undefined : { apiBaseUrl })),
    Layer.provideMerge(PolarSdk.PolarProtocol),
    Layer.provideMerge(PolarAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
};
