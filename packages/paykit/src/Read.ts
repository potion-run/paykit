/**
 * The read vocabulary: the catalog a deployment sells, the state a standing
 * folds into, the two per-account views, the cross-account projection and the
 * timeline. A console, a dashboard or an export reads this entry; it never
 * needs the model, the bindings or a provider to render a row.
 *
 * Everything here is a type or a pure/layer value; there is no command in this
 * entry. A write comes through `@potion.run/paykit` (the root), `./Billing` or
 * `./Admin`, so a reader cannot reach a mutation by reading.
 *
 * @entry
 */
export {
  Allowance,
  AllowanceKind,
  Included,
  Overage,
  Resets,
  UnitPrice,
  allowance,
  isFlagGrant,
  unitPriceKey,
} from "./Allowance.ts";
export type { AllowanceInput } from "./Allowance.ts";
export { Catalog, catalog } from "./Catalog.ts";
export type { CatalogInput } from "./Catalog.ts";
export { CatalogService, catalogLayer } from "./CatalogService.ts";
export { CreditRateCards, CreditRates, Feature, FeatureId, feature } from "./Feature.ts";
export type { FeatureInput } from "./Feature.ts";
export { Proration } from "./Proration.ts";
export { CreditsExpire, Interval, Price, Tier, TierId, TopUpThreshold, tier } from "./Tier.ts";
export type { TierInput } from "./Tier.ts";
export {
  BillingReadPage,
  BillingReadQuery,
  BillingReadRow,
  BillingReadStore,
  DEFAULT_PAGE,
  MAX_PAGE,
  MemoryBillingReadStore,
  queryRows,
} from "./BillingReadStore.ts";
export {
  BillingState,
  BillingStateView,
  initialBillingState,
} from "./Subscription/BillingState.view.ts";
export {
  Entitlements,
  EntitlementsState,
  FeatureEntitlement,
  PricedUnits,
  initialEntitlements,
} from "./Subscription/Entitlements.view.ts";
export {
  AccountId,
  HoldRecord,
  PendingTier,
  Refs,
  Standing,
  SubscribedState,
  SubscriptionState,
  SubscriptionStatus,
  standingOf,
} from "./Subscription/Subscription.state.ts";
export {
  AccountEvent,
  TimelineEntry,
  UsageTimeline,
  appendTimeline,
  initialTimeline,
} from "./Timeline.ts";
export { VerifyMismatch } from "./Verify.ts";
