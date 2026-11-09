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
 */
export {
  Allowance,
  AllowanceKind,
  Included,
  Overage,
  ResetEvery,
  Resets,
  UnitPrice,
  allowance,
  carryCapOf,
  isFlagGrant,
  pricingOf,
  resetEveryOf,
  unitPriceKey,
} from "./Allowance.ts";

export type { AllowanceInput, PriceBand, Pricing, PricingInput } from "./Allowance.ts";

export { Catalog, catalog } from "./Catalog.ts";

export type { CatalogInput } from "./Catalog.ts";

export { CatalogService, catalogLayer } from "./CatalogService.ts";

export {
  CreditRateCards,
  CreditRates,
  Feature,
  FeatureId,
  RateCard,
  RateMatch,
  RateMultiplier,
  RateRule,
  creditRateOf,
  feature,
  rateCard,
} from "./Feature.ts";

export type { FeatureInput, RateCardInput } from "./Feature.ts";

export {
  BillingUnits,
  PricedLine,
  currencyOfPricing,
  priceKey,
  priceOf,
  priceOfUnits,
  pricedLines,
  pricesOf,
  pricing,
  pricingKey,
  soleUnitPriceOf,
  unitsOf,
} from "./Pricing.ts";

export { Proration } from "./Proration.ts";

export {
  AdditionalCurrency,
  CreditsExpire,
  Interval,
  Price,
  Tier,
  TierCustomize,
  TierId,
  TopUpPackId,
  TopUpTerms,
  TopUpThreshold,
  priceFor,
  tier,
} from "./Tier.ts";

export type { TierInput, TopUpTermsInput } from "./Tier.ts";

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
  RefundView,
  initialBillingState,
  outstandingRefundOf,
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
  STANDING_PHASE_EDGES,
  STANDING_PHASE_TRANSITIONS,
  STANDING_TRANSITIONS,
  StandingConditions,
  StandingPhase,
  StandingPhaseTag,
  TopUpCooldownCondition,
  ProrationCondition,
  isStandingPhaseEdge,
  nextStandingPhase,
  standingConditionsOf,
  standingPhaseEdge,
  standingPhaseOf,
  standingPhaseOfView,
  standingPhaseTagOfStatus,
  standingTransitionOf,
} from "./Subscription/StandingPhase.ts";

export type {
  StandingPhaseEdge,
  StandingPhaseView,
  StandingTransition,
} from "./Subscription/StandingPhase.ts";

export {
  HOLD_STATUS_TRANSITIONS,
  HOLD_TRANSITIONS,
  holdTransitionOf,
  nextHoldStatus,
} from "./Subscription/HoldPhase.ts";

export type { HoldTransition } from "./Subscription/HoldPhase.ts";

export {
  AccountEvent,
  TimelineEntry,
  UsageTimeline,
  appendTimeline,
  initialTimeline,
} from "./Timeline.ts";

export { VerifyMismatch } from "./Verify.ts";

export { PlanItemReset } from "./Subscription/ResetAllowance.command.ts";

export {
  Balance,
  BalancePage,
  BalanceSource,
  BalanceSourceKind,
  balanceOf,
  balancesOf,
  emptyBalance,
} from "./Balance.ts";

export { Customer, CustomerId, CustomerPlan, BillingControls } from "./Customer.ts";

export { plan } from "./Plan.ts";

export { planItem } from "./PlanItem.ts";

export { planTermsOf } from "./Catalog.ts";

export { schedulePlanChangeInputOf, subscribePlanInputOf } from "./TierCommand.ts";
