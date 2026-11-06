// Stripe for paykit: one call that returns a `Payments` provider.
// This package is paykit-shaped on purpose — see ../AGENTS.md.
export { Stripe, stripeClientBindings, stripePriceOf } from "./Stripe.ts";
export type {
  StripeClient,
  StripeOrigin,
  StripeProps,
  StripeTier,
  StripeUsagePrice,
} from "./Stripe.ts";
export { distilledStripeClient, STRIPE_API_BASE_URL, stripeBaseUrl } from "./StripeClient.ts";
// The deploy half: the catalog creates the prices its tiers are sold at.
export {
  StripePrices,
  lookupKeyOf,
  declaredLookupKeys,
  meterEventNameOf,
  meteredLookupKeyOf,
  retiredPrices,
  lookupKeyPrefixOf,
  priceDeclarations,
  soldTiers,
  tierOfDeclaration,
} from "./Prices.ts";
export type { PriceDeclaration, SoldPrice, SoldPrices, UsagePriceDeclaration } from "./Prices.ts";
export type { StripeClientConfig } from "./StripeClient.ts";
// The other half of a deployment: the webhook that activates a standing.
export { stripeWebhook } from "./Webhooks.ts";
export type { StripeWebhookError, StripeWebhookProps, StripeWebhookRequest } from "./Webhooks.ts";
export { RetiredPrices } from "./RetiredPrices.ts";
export type { ArchivedPrices } from "./RetiredPrices.ts";
// Provisioning and the provider in one call, for the common deployment.
export { StripeBilling } from "./StripeBilling.ts";
export type { StripeBillingProps, StripeBillingProvider } from "./StripeBilling.ts";
