// @potion.run/paykit — four export groups: deploy-time resources, runtime
// bindings, the model, and providers. Everything a user can import is API.

// ── 1. deploy-time ──────────────────────────────────────────────────────────
export {
  CreditRateCards,
  CreditRates,
  Feature,
  FeatureId,
  FeatureKind,
  feature,
  messages,
  seats,
  storage_gb,
} from "./Feature.ts";
export type { FeatureInput } from "./Feature.ts";
export {
  Allowance,
  Allowances,
  Included,
  Overage,
  Resets,
  UnitPrice,
  allowance,
  grant,
} from "./Allowance.ts";
export type { AllowanceInput } from "./Allowance.ts";
export { CreditsExpire, Interval, Price, Tier, TierId, TierKind, tier } from "./Tier.ts";
export type { TierInput } from "./Tier.ts";
export {
  Catalog,
  CatalogDuplicateAllowance,
  CatalogDuplicateFeature,
  CatalogDuplicateTier,
  CatalogCapWithoutBilling,
  CatalogCarryOverNeverResets,
  CatalogCarryOverOnFlag,
  CatalogCreditRatesOnFlag,
  CatalogCreditFeatureHasAllowance,
  CatalogCreditGrantInvalid,
  CatalogCreditRateInvalid,
  CatalogCreditRateMissing,
  CatalogEmptyTier,
  CatalogError,
  CatalogFlagNotGranted,
  CatalogInvalid,
  CatalogOneOffCredits,
  CatalogOneOffCreditsExpire,
  CatalogOneOffGrant,
  CatalogOneOffWithoutPrice,
  CatalogMoneyCapWithoutUnitPrice,
  CatalogUnitPriceCurrency,
  CatalogUnitPriceWithoutBilling,
  CatalogUnknownFeature,
  CatalogUnlimitedOverage,
  CatalogFlagOnMetered,
  allowancesOf,
  catalog,
  creditRatesOf,
  creditTermsOf,
  defineCatalog,
  featureOf,
  tierOf,
  tierTermsOf,
} from "./Catalog.ts";
export type { CatalogInput } from "./Catalog.ts";
export {
  CatalogPriceMismatch,
  MemoryStore,
  NoPurchasePath,
  Postgres,
  ProviderDuplicate,
  ProviderDescriptor,
  Sqlite,
  Stack,
  providerDescriptor,
  validateProviderMappings,
} from "./Stack.ts";
export type { BillingStack, StackProps, Store } from "./Stack.ts";
export {
  BILLING_STACK_VERSION,
  BillingStack as BillingStackResource,
  BillingStackAttrs,
  BillingStackProps,
  BillingStackProvider,
  BillingStackStateOutdated,
  BillingStore,
  providers,
  readBillingStack,
  reconcileBillingStack,
} from "./BillingStack.resource.ts";
export { doctor } from "./Doctor.ts";
export { Paykit } from "./Paykit.ts";
export type { DoctorMismatch } from "./Doctor.ts";
export { SqlEventLog } from "./Store/SqlEventLog.ts";
export { SqlAggregateStore } from "./Store/SqlAggregateStore.ts";
export type { SqlAggregateStoreOptions } from "./Store/SqlAggregateStore.ts";
export {
  SqlPolicyStore,
  SqlProjectionStore,
  SqlStreamStore,
  SqlViewStore,
} from "./Store/SqlConsumers.ts";
export type { SqlConsumerOptions } from "./Store/SqlConsumers.ts";
export { SqlPlatform, layerSqlPlatform } from "./Store/SqlPlatform.ts";
export { SqlBillingReadStore } from "./Store/SqlBillingReadStore.ts";
export type { SqlModelHost, SqlPlatformOptions } from "./Store/SqlPlatform.ts";
export type {
  AppendInput,
  AppendResult,
  PendingDelivery,
  ScheduledCommand,
  SqlEventLogOptions,
  StoredEventRow,
} from "./Store/SqlEventLog.ts";
export { SqlError, asyncOf } from "./Store/Sql.ts";
export type {
  SqlAsyncExecutor,
  SqlDialect,
  SqlExecutor,
  SqlSyncExecutor,
  SqlValue,
} from "./Store/Sql.ts";
export { d1Executor } from "./Store/D1.ts";
export type { D1Like } from "./Store/D1.ts";
export {
  MigrationError,
  MigrationHistoryConflictError,
  RewrittenMigrationHistoryError,
  migrate,
  migrateDryRun,
  migrationFiles,
  readMigrationFiles,
} from "./Migrations/index.ts";
export type {
  MigrationApplyError,
  MigrationFile,
  MigrationRecord,
  MigrationScope,
  MigrateOptions,
} from "./Migrations/index.ts";

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
export { Subscribe } from "./Subscribe.ts";
export type { SubscribeInput, SubscribeResult } from "./Subscribe.ts";
export { Portal } from "./Portal.ts";
export type { PortalInput } from "./Portal.ts";
export { List } from "./List.ts";
export { CatalogService, catalogLayer } from "./CatalogService.ts";
export { CatalogGuard, CatalogGuardLive, catalogMismatchOf } from "./CatalogGuard.ts";
export { CatalogMismatch } from "./CatalogMismatch.rejection.ts";
export { Preview } from "./Preview.ts";
export { ChargeProration, ChargeProrationResult } from "./ChargeProration.ts";
export type { ChargeProrationInput } from "./ChargeProration.ts";
export { Proration, ProrationPeriod, prorate, unusedFraction } from "./Proration.ts";
export type { Proration as ProrationValue } from "./Proration.ts";
export type { PreviewCommand, PreviewEvent, PreviewInput, PreviewResult } from "./Preview.ts";
export {
  MissingProviderRef,
  OrphanProviderRef,
  TierHasNoPurchasePath,
  Verify,
  VerifyMismatch,
  verifyState,
} from "./Verify.ts";
export type { VerifyOptions } from "./Verify.ts";
export {
  WebhookAction,
  WebhookEvent,
  WebhookInvalid,
  WebhookKind,
  Webhook,
  WebhookSignatureInvalid,
  completeCheckout,
  handleWebhook,
} from "./Webhooks.ts";
export type { PaymentsWebhook, WebhookError, WebhookRequest } from "./Webhooks.ts";
export { Track } from "./Track.ts";
export type { TrackInput } from "./Track.ts";
export { Hold, Release, Settle } from "./Hold.ts";
export type {
  HoldInput,
  HoldResult,
  ReleaseInput,
  ReleaseResult,
  SettleInput,
  SettleResult,
} from "./Hold.ts";

// ── 3. model ────────────────────────────────────────────────────────────────
export { PaykitHandlers, PaykitModel as Model } from "./Paykit.model.ts";
export { BillingApi } from "./BillingApi.api.ts";
export { BillingAdminApi } from "./BillingAdminApi.api.ts";
export { Subscription, subscriptionRef } from "./Subscription/Subscription.aggregate.ts";
export { allowsOne } from "./Subscription/Entitlements.view.ts";
export { ProrationMismatch } from "./Subscription/ProrationMismatch.rejection.ts";
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
// ── auth ────────────────────────────────────────────────────────────────────
export {
  Actor,
  account as actorAccount,
  admin as actorAdmin,
  mayActOn,
  system,
} from "./Auth/Actor.ts";
export type { ActorKind, ActorValue } from "./Auth/Actor.ts";
export { Forbidden } from "./Auth/Forbidden.rejection.ts";
export { Unauthenticated } from "./Auth/Unauthenticated.rejection.ts";
export { Admin, Session } from "./Auth/Guards.ts";
export {
  ACTOR_HEADER,
  AdminFromHeaders,
  DevGuards,
  KIND_HEADER,
  SessionFromHeaders,
  actorFromHeaders,
} from "./Auth/FromHeaders.ts";
export { AccountId } from "./Subscription/Subscription.id.ts";
export { AccountEvents } from "./Subscription/AccountEvents.stream.ts";
export { AccountEventsProjection } from "./Subscription/AccountEventsProjection.ts";
export { BillingRead } from "./Subscription/BillingRead.projection.ts";
export {
  PeriodCloseUsage,
  billableQuantities,
  periodUsageCommandId,
} from "./Subscription/PeriodCloseUsage.policy.ts";
export { PeriodRollover } from "./Subscription/PeriodRollover.policy.ts";
export { Dunning } from "./Subscription/Dunning.policy.ts";
export {
  AccountOrder,
  BillingReadQuery,
  BillingReadStore,
  BillingReadPage,
  DEFAULT_PAGE,
  MAX_PAGE,
  MemoryBillingReadStore,
  BillingReadRow,
  queryRows,
} from "./BillingReadStore.ts";
export { BillingState } from "./Subscription/BillingState.view.ts";
export { BillingStateView } from "./Subscription/BillingState.view.ts";
export { Entitlements } from "./Subscription/Entitlements.view.ts";
export { EntitlementsState } from "./Subscription/Entitlements.view.ts";
export type { FeatureEntitlement } from "./Subscription/Entitlements.view.ts";

// Events are public API: their names and fields are the contract.
export {
  SubscriptionActivated,
  Subscribe as SubscribeCommand,
} from "./Subscription/Subscribe.command.ts";
export { TrialStarted, StartTrial } from "./Subscription/StartTrial.command.ts";
export { TierChanged, ChangeTier, DowngradeBelowUsage } from "./Subscription/ChangeTier.command.ts";
export {
  AllowanceExceeded,
  CreditExceeded,
  FeatureNotMetered,
  MoneyCapExceeded,
  SpendCapExceeded,
  StandingBlocksUsage,
  TrackUsage,
  UsageRecorded,
} from "./Subscription/TrackUsage.command.ts";
export {
  HOLD_TTL_MINUTES,
  // The command; the binding of the same name comes from `./Hold.ts`.
  Hold as HoldCommand,
  HoldExceeded,
  HoldExpired,
  HoldSettled,
  HoldUnknown,
  UsageReserved,
  defaultHoldExpiry,
} from "./Subscription/Hold.command.ts";
export { SettleHold, UsageSettled } from "./Subscription/SettleHold.command.ts";
export { ReleaseHold, UsageReleased } from "./Subscription/ReleaseHold.command.ts";
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
  NoProrationDue,
  ProrationInvoiced,
  RecordProrationInvoice,
} from "./Subscription/RecordProrationInvoice.command.ts";
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
export type { MemoryPayments, MemoryUsageReport } from "./PaymentsMemory.ts";
export { PaymentsManual as Manual } from "./PaymentsManual.ts";
export { PaymentsStripe, PaymentsStripe as Stripe } from "./PaymentsStripe.ts";
export type {
  StripeBindings,
  StripeProps,
  StripeTier,
  StripeUsagePrice,
} from "./PaymentsStripe.ts";
export { encodeVendorPart } from "./VendorId.ts";
export { Outbound, OutboundDeliveryError, OutboundEvents, outboundSignature } from "./Outbound.ts";
export type { OutboundEndpoint, OutboundRequest } from "./Outbound.ts";
export { PaymentsPolar } from "./PaymentsPolar.ts";
export type { PolarBindings, PolarProps, PolarTier } from "./PaymentsPolar.ts";
export {
  PaymentCapability,
  PaymentCapabilities,
  PaymentDeclined,
  Payments,
  PaymentsProvider,
  PaymentsRouter,
  ProviderCapabilityMissing,
  MoneyProviderKind,
  paymentsRouter,
  providerFor,
} from "./Payments.ts";
export type { ProviderSet } from "./Payments.ts";
export type { PaymentError, PaymentsService, MoneyProvider, UnitPriceMap } from "./Payments.ts";
