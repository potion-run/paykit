import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/polar";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import { POLAR_AUTH_PROVIDER_NAME, type PolarResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  fromApiKey,
  type Config as CredentialsConfig,
} from "@distilled.cloud/polar";

/**
 * Build a Polar `Credentials` layer that resolves credentials via the Alchemy
 * AuthProvider using the configured profile (defaults to `default`, overridable
 * with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/polar`'s `{ apiKey, apiBaseUrl }` shape.
 * Distilled's `Credentials` service is an `Effect<Config>` resolved per
 * request. Environment credentials (`POLAR_API_KEY`) take precedence; otherwise
 * the selected profile is used.
 *
 * `baseUrl` is the deployment's server choice: when it is given, it wins over
 * the token's stored base URL, so `polarProviders({ server: "sandbox" })`
 * always points a token at the sandbox.
 *
 * ### Resolving the deploy's token
 * **Example:** Environment first, then the selected profile
 * ```typescript
 * const credentials = fromAuthProvider({ apiBaseUrl: "https://sandbox-api.polar.sh" });
 * ```
 *
 * @layer
 * @product Polar
 */
export const fromAuthProvider = (overrides?: { readonly apiBaseUrl?: string }) =>
  Layer.effect(
    Credentials,
    lazyCredentials<PolarResolvedCredentials, ConfigError>()(
      POLAR_AUTH_PROVIDER_NAME,
      (credentials) => ({
        apiKey: credentials.apiKey,
        apiBaseUrl: overrides?.apiBaseUrl ?? credentials.apiBaseUrl,
      }),
    ),
  );
