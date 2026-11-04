// Polar for paykit: one call that returns a `Payments` provider.
// This package is paykit-shaped on purpose — see ../AGENTS.md.
export { Polar, polarBindings, polarLayer, polarPriceOf } from "./Polar.ts";
export type { PolarClient, PolarProps, PolarServer, PolarTier } from "./Polar.ts";
export { distilledPolarClient, POLAR_BASE_URL, polarBaseUrl } from "./PolarClient.ts";
export type { PolarClientConfig } from "./PolarClient.ts";
// The other half of a deployment: the webhook that activates a standing.
export { polarWebhook } from "./Webhooks.ts";
export type { PolarWebhookError, PolarWebhookProps, PolarWebhookRequest } from "./Webhooks.ts";
