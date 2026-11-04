// Stripe for paykit: one call that returns a `Payments` provider.
// This package is paykit-shaped on purpose — see ../AGENTS.md.
export { Stripe, stripeClientBindings, stripePriceOf } from "./Stripe.ts";
export type { StripeClient, StripeOrigin, StripeProps, StripeTier } from "./Stripe.ts";
export { distilledStripeClient, STRIPE_API_BASE_URL, stripeBaseUrl } from "./StripeClient.ts";
// The deploy half: the catalog creates the prices its tiers are sold at.
export { StripePrices, lookupKeyOf, priceDeclarations, tierOfDeclaration } from "./Prices.ts";
export type { PriceDeclaration, SoldPrice } from "./Prices.ts";
export type { StripeClientConfig } from "./StripeClient.ts";
// The other half of a deployment: the webhook that activates a standing.
export { stripeWebhook } from "./Webhooks.ts";
export type { StripeWebhookError, StripeWebhookProps, StripeWebhookRequest } from "./Webhooks.ts";
