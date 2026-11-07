// Polar for paykit: one call that returns a `Payments` provider, and the
// products its tiers are sold as, provisioned from the catalog.
// This package is paykit-shaped on purpose — see ../AGENTS.md.
export { Polar, polarBindings, polarLayer, polarPriceOf } from "./Polar.ts";
export type { PolarClient, PolarProps, PolarServer, PolarTier } from "./Polar.ts";
export { distilledPolarClient, POLAR_BASE_URL, polarBaseUrl } from "./PolarClient.ts";
export type { PolarClientConfig } from "./PolarClient.ts";
export {
  PolarPrices,
  declaredProductNames,
  priceDeclarations,
  productNameOf,
  productNamePrefixOf,
  retiredProducts,
  soldTiers,
} from "./Prices.ts";
export type {
  FoundProduct,
  ProductDeclaration,
  ProductUsageDeclaration,
  SoldPrices,
  SoldProduct,
} from "./Prices.ts";
// Provisioning and the provider in one call, for the common deployment.
export { PolarBilling } from "./PolarBilling.ts";
export type { PolarBillingProps, PolarBillingProvider } from "./PolarBilling.ts";
export { RetiredProducts } from "./RetiredProducts.ts";
export type { ArchivedProducts } from "./RetiredProducts.ts";
export { PAYKIT_TIER, Product } from "./Product.ts";
export type { ProductUsage } from "./Product.ts";
export {
  Meter,
  MeterProvider,
  PAYKIT_FEATURE,
  meterAggregationOf,
  meterEventNameOf,
  meterFilterOf,
  meterNameOf,
} from "./Meter.ts";
export type { MeterProps } from "./Meter.ts";
export type { ProductProps } from "./Product.ts";
export { Providers, polarProviders } from "./Providers.ts";
export type { PolarProvidersProps } from "./Providers.ts";
// The other half: the webhook that activates a standing.
export { polarWebhook } from "./Webhooks.ts";
export type { PolarWebhookError, PolarWebhookProps, PolarWebhookRequest } from "./Webhooks.ts";
