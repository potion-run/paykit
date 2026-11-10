import { DEFAULT_API_BASE_URL } from "@distilled.cloud/polar";
import { getEnv, getEnvRedactedRequired } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const POLAR_AUTH_PROVIDER_NAME = "Polar";
export const POLAR_API_KEY_ENV = "POLAR_API_KEY";
export const POLAR_API_BASE_URL_ENV = "POLAR_API_BASE_URL";

export type PolarAuthConfig = StoredAuthConfig;

export type PolarResolvedCredentials = {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: PolarAuthConfig["method"] | "env"; details?: string };
};

const polarAuth = makeStoredAuthProvider<PolarResolvedCredentials>({
  provider: POLAR_AUTH_PROVIDER_NAME,
  fields: [
    { name: "apiKey", label: "Polar Access Token", secret: true },
    {
      name: "apiBaseUrl",
      label: "Polar API base URL",
      optional: true,
      placeholder: DEFAULT_API_BASE_URL,
    },
  ],
  toResolved: (values) => ({
    type: "apiKey",
    apiKey: storedSecret(values.apiKey) ?? Redacted.make(""),
    apiBaseUrl: storedValueText(values.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    source: { type: "stored" },
  }),
  readEnvironment: Effect.all({
    apiKey: getEnvRedactedRequired(POLAR_API_KEY_ENV),
    apiBaseUrl: getEnv(POLAR_API_BASE_URL_ENV),
  }).pipe(
    Effect.map(({ apiKey, apiBaseUrl }) => ({
      type: "apiKey" as const,
      apiKey,
      apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
      source: {
        type: "env" as const,
        details: apiBaseUrl ? `${POLAR_API_KEY_ENV}, ${POLAR_API_BASE_URL_ENV}` : POLAR_API_KEY_ENV,
      },
    })),
  ),
  environment: [
    { name: POLAR_API_KEY_ENV, required: true, secret: true },
    { name: POLAR_API_BASE_URL_ENV, required: false },
  ],
});

/**
 * Layer that registers the Polar {@link AuthProvider} into the
 * {@link AuthProviders} registry. Include this in the Polar `providers()` layer
 * so the alchemy CLI can discover it.
 *
 * Auth is a Polar access token (`POLAR_API_KEY`, from the dashboard). Polar has
 * no OAuth flow. An optional `POLAR_API_BASE_URL` overrides the API root
 * (default `https://api.polar.sh`); `polarProviders({ server: "sandbox" })`
 * overrides it to the sandbox host instead, so a production token cannot be
 * sent to the sandbox by accident.
 *
 * @layer
 * @product Polar
 */
export const PolarAuth = polarAuth.layer;
