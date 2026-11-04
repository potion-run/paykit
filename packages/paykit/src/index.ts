// @potion.run/paykit — four export groups: deploy-time resources, runtime
// bindings, the model, and providers. Everything a user can import is API.

// ── 1. deploy-time ──────────────────────────────────────────────────────────
export { Feature, FeatureId, feature, messages, seats, storage_gb } from "./Feature.ts";
export type { FeatureInput } from "./Feature.ts";
export { Allowance, Allowances, Overage, Resets, allowance } from "./Allowance.ts";
export type { AllowanceInput } from "./Allowance.ts";
export { Interval, Price, Tier, TierId, tier } from "./Tier.ts";
export type { TierInput } from "./Tier.ts";
export {
  Catalog,
  CatalogDuplicateAllowance,
  CatalogDuplicateFeature,
  CatalogDuplicateTier,
  CatalogEmptyTier,
  CatalogError,
  CatalogInvalid,
  CatalogUnknownFeature,
  allowancesOf,
  catalog,
  defineCatalog,
  featureOf,
  tierOf,
} from "./Catalog.ts";
export type { CatalogInput } from "./Catalog.ts";
export {
  CatalogPriceMismatch,
  MemoryStore,
  NoPurchasePath,
  Postgres,
  ProviderDescriptor,
  Sqlite,
  Stack,
  providerDescriptor,
  validateProviderMappings,
} from "./Stack.ts";
export type { BillingStack, StackProps, Store } from "./Stack.ts";
export {
  BillingStack as BillingStackResource,
  BillingStackAttrs,
  BillingStackProps,
  BillingStackProvider,
  BillingStore,
} from "./BillingStack.resource.ts";
export { doctor } from "./Doctor.ts";
export type { DoctorMismatch } from "./Doctor.ts";
export { SqlEventLog } from "./Store/SqlEventLog.ts";
export type {
  AppendInput,
  AppendResult,
  PendingDelivery,
  ScheduledCommand,
  StoredEventRow,
} from "./Store/SqlEventLog.ts";
export type { SqlExecutor, SqlValue } from "./Store/Sql.ts";
export { migrate, migrateDryRun, migrationFiles } from "./Migrations/index.ts";
export type { SqlFile } from "./Migrations/index.ts";

// ── 2. runtime ──────────────────────────────────────────────────────────────
export {
  Check,
  CheckFailed,
  CheckHttp,
  CheckInProcess,
  CheckReadModel,
  CheckTransport,
  evaluateCheck,
} from "./Check.ts";
export type { CheckInput, CheckResult } from "./Check.ts";
export { Checkout, completeCheckout } from "./Checkout.ts";
export type { CheckoutInput, CheckoutResult } from "./Checkout.ts";
export {
  WebhookAction,
  WebhookEvent,
  WebhookInvalid,
  WebhookKind,
  handleWebhook,
} from "./Webhooks.ts";
export { Track } from "./Track.ts";
export type { TrackInput } from "./Track.ts";
export { Subscribe } from "./Subscribe.ts";
export type { SubscribeInput, SubscribeResult } from "./Subscribe.ts";
export { Portal } from "./Portal.ts";
export type { PortalInput } from "./Portal.ts";
export { CatalogService, catalogLayer } from "./CatalogService.ts";

// ── 3. model ────────────────────────────────────────────────────────────────
export { PaykitHandlers, PaykitModel as Model } from "./Paykit.model.ts";
export { BillingApi } from "./BillingApi.api.ts";
export { BillingAdminApi } from "./BillingAdminApi.api.ts";
export { Subscription, subscriptionRef } from "./Subscription/Subscription.aggregate.ts";
export {
  Period,
  Standing,
  SubscriptionStatus,
  initialSubscriptionState,
  periodFrom,
  standingOf,
  statusOf,
} from "./Subscription/Subscription.state.ts";
export type {
  SubscribedState,
  SubscriptionState,
  UnsubscribedState,
} from "./Subscription/Subscription.state.ts";
export { AccountId } from "./Subscription/Subscription.id.ts";
export { AccountEvents } from "./Subscription/AccountEvents.stream.ts";
export { AccountEventsProjection } from "./Subscription/AccountEventsProjection.ts";
export { BillingRead } from "./Subscription/BillingRead.projection.ts";
export { PeriodRollover } from "./Subscription/PeriodRollover.policy.ts";
export { Dunning } from "./Subscription/Dunning.policy.ts";
export { BillingReadStore, MemoryBillingReadStore } from "./BillingReadStore.ts";
export type { BillingReadRow } from "./BillingReadStore.ts";
export { BillingState } from "./Subscription/BillingState.view.ts";
export type { BillingStateView } from "./Subscription/BillingState.view.ts";
export { Entitlements } from "./Subscription/Entitlements.view.ts";
export type { EntitlementsState, FeatureEntitlement } from "./Subscription/Entitlements.view.ts";

// Events are public API: their names and fields are the contract.
export {
  SubscriptionActivated,
  Subscribe as SubscribeCommand,
} from "./Subscription/Subscribe.command.ts";
export { TrialStarted, StartTrial } from "./Subscription/StartTrial.command.ts";
export { TierChanged, ChangeTier, DowngradeBelowUsage } from "./Subscription/ChangeTier.command.ts";
export {
  AllowanceExceeded,
  StandingBlocksUsage,
  TrackUsage,
  UsageRecorded,
} from "./Subscription/TrackUsage.command.ts";
export { PaymentRecorded, RecordPayment } from "./Subscription/RecordPayment.command.ts";
export {
  PaymentFailed,
  RecordPaymentFailure,
} from "./Subscription/RecordPaymentFailure.command.ts";
export { AlreadyInGrace, EnterGrace, GraceEntered } from "./Subscription/EnterGrace.command.ts";
export { Recover, Recovered } from "./Subscription/Recover.command.ts";
export { CreditsGranted, GrantCredits } from "./Subscription/GrantCredits.command.ts";
export {
  ConsumeCredits,
  CreditExceedsBalance,
  CreditsConsumed,
} from "./Subscription/ConsumeCredits.command.ts";
export {
  CancellationScheduled,
  ScheduleCancellation,
} from "./Subscription/ScheduleCancellation.command.ts";
export { CancellationWithdrawn, Resume } from "./Subscription/Resume.command.ts";
export {
  ClosePeriod,
  CreditsExpired,
  PeriodClosed,
  PeriodNotClosed,
  UsageReset,
} from "./Subscription/ClosePeriod.command.ts";
export { Expire, SubscriptionExpired } from "./Subscription/Expire.command.ts";
export { GraceElapsed } from "./Subscription/GraceElapsed.command.ts";
export { PeriodEnded } from "./Subscription/PeriodEnded.command.ts";
export { ExtendTrial, TrialExtended, TrialNotActive } from "./Subscription/ExtendTrial.command.ts";
export {
  AttachProviderRef,
  ProviderRefAttached,
} from "./Subscription/AttachProviderRef.command.ts";
export {
  AlreadyCanceled,
  AlreadyCanceled as AlreadyCanceledRejection,
} from "./Subscription/AlreadyCanceled.rejection.ts";
export { CurrencyMismatch } from "./Subscription/CurrencyMismatch.rejection.ts";
export { NotInGrace } from "./Subscription/NotInGrace.rejection.ts";
export { NotScheduled } from "./Subscription/NotScheduled.rejection.ts";
export { NotSubscribed } from "./Subscription/NotSubscribed.rejection.ts";
export { TierNotInCatalog } from "./Subscription/TierNotInCatalog.rejection.ts";
export { TrialAlreadyUsed } from "./Subscription/TrialAlreadyUsed.rejection.ts";

// ── 4. providers ────────────────────────────────────────────────────────────
export { PaymentsMemory as Memory } from "./PaymentsMemory.ts";
export { PaymentsManual as Manual } from "./PaymentsManual.ts";
export { PaymentsStripe as Stripe } from "./PaymentsStripe.ts";
export type { StripeBindings, StripeProps, StripeTier } from "./PaymentsStripe.ts";
export { PaymentsPolar as Polar } from "./PaymentsPolar.ts";
export type { PolarBindings, PolarProps, PolarTier } from "./PaymentsPolar.ts";
export {
  PaymentCapability,
  PaymentCapabilities,
  PaymentDeclined,
  PaymentsProvider,
  ProviderCapabilityMissing,
  ProviderKind,
  Payments,
} from "./Payments.ts";
export type { PaymentError, PaymentsService, Provider } from "./Payments.ts";
