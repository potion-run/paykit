// @potion.run/paykit — four export groups: deploy-time resources, runtime
// bindings, the model, and providers. Everything a user can import is API.

// ── 1. deploy-time ──────────────────────────────────────────────────────────
export {
  CreditRateCards,
  CreditRates,
  Feature,
  FeatureId,
  FeatureKind,
  RateCard,
  RateMatch,
  RateMultiplier,
  RateRule,
  creditRateOf,
  feature,
  messages,
  rateCard,
  seats,
  storage_gb,
} from "./Feature.ts";

export type { FeatureInput, RateCardInput } from "./Feature.ts";

export {
  Included,
  Overage,
  ResetEvery,
  Resets,
  UnitPrice,
  carryCapOf,
  grant,
  pricingOf,
  resetEveryOf,
  unitPriceKey,
} from "./Allowance.ts";

export type { PriceBand, Pricing, PricingInput } from "./Allowance.ts";

export { PlanItem, PlanItems, planItem } from "./PlanItem.ts";

export type { PlanItemInput } from "./PlanItem.ts";

export {
  BillingUnits,
  PricedLine,
  currencyOfPricing,
  priceKey,
  priceOf,
  priceOfUnits,
  pricedLines,
  asPricing,
  pricesOf,
  pricing,
  pricingKey,
  soleUnitPriceOf,
  unitAmountDecimalOf,
  unitsOf,
} from "./Pricing.ts";

export type { PricingValue } from "./Pricing.ts";

export {
  AdditionalCurrency,
  CreditsExpire,
  Interval,
  PlanTrial,
  Price,
  TopUpPackId,
  TopUpTerms,
  TopUpThreshold,
  priceFor,
} from "./Tier.ts";

export type { TopUpTermsInput } from "./Tier.ts";

export { Plan, PlanCustomize, PlanId, PlanKind, plan } from "./Plan.ts";

export {
  Balance,
  BalancePage,
  BalanceSource,
  BalanceSourceKind,
  balanceOf,
  balanceOfEntity,
  balanceOfScope,
  balancesOf,
  balancesOfEntity,
  balancesOfScope,
  emptyBalance,
  pooledSourceOf,
} from "./Balance.ts";

export {
  BillingControls,
  CUSTOMER_SCOPE,
  Customer,
  CustomerAutoTopUp,
  CustomerId,
  CustomerPlan,
  CustomerSpendLimit,
  CustomerUsageAlert,
  Entity,
  EntityId,
  EntityStatus,
  ScopeRef,
  controlsKey,
  entityScope,
  normalizeBillingControls,
  scopeEntityId,
} from "./Customer.ts";

export {
  Catalog,
  CatalogDuplicateAllowance,
  CatalogDuplicateFeature,
  CatalogDuplicateTier,
  CatalogAdditionalCurrency,
  CatalogCapWithoutBilling,
  CatalogProrateOnMetered,
  CatalogQuantityCap,
  CatalogQuantityField,
  CatalogQuantityIncluded,
  CatalogQuantityKind,
  CatalogQuantityPricing,
  CatalogQuantityResets,
  CatalogQuantityWithoutPrice,
  CatalogRateCardOnQuantity,
  CatalogCarryOverNeverResets,
  CatalogCarryWithoutCarry,
  CatalogCustomAddOn,
  CatalogCustomDefaultPlan,
  CatalogCustomPack,
  CatalogCustomizeWithoutVariant,
  CatalogPricingBand,
  CatalogPricingConflict,
  CatalogPricingCurrency,
  CatalogPricingWithoutBilling,
  CatalogRateCardConflict,
  CatalogRateCardOnFlag,
  CatalogRateCardOverride,
  CatalogRateInvalid,
  CatalogResetEveryNever,
  CatalogUnknownVariant,
  CatalogVariantCycle,
  CatalogVariantOnPack,
  CatalogVolumeRateRises,
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
  CatalogTopUpOnPack,
  CatalogUnknownTopUpPack,
  CatalogTopUpRetryInvalid,
  CatalogMoneyCapWithoutUnitPrice,
  CatalogUnitPriceCurrency,
  CatalogUnitPriceWithoutBilling,
  CatalogUnknownFeature,
  CatalogUnlimitedOverage,
  CatalogFlagOnMetered,
  catalog,
  creditRatesOf,
  creditTermsOf,
  defineCatalog,
  ratesOf,
  featureOf,
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
  providerDescriptor,
  validateProviderMappings,
  validateStack,
} from "./Stack.ts";

export type { Store, ValidateStackProps, ValidatedBillingStack } from "./Stack.ts";

export { BillingStack } from "./BillingStack.ts";

export type { BillingDeployment, BillingStackProps } from "./BillingStack.ts";

export {
  BILLING_STACK_VERSION,
  BillingStack as BillingStackResource,
  BillingStackAttrs,
  BillingStackProvider,
  BillingStackRecord,
  BillingStackStateTooNew,
  diffBillingStack,
  BillingStore,
  providers,
  readBillingStack,
  reconcileBillingStack,
  billingStackVersionOf,
} from "./BillingStack.resource.ts";

// The resource's shape, so a stack's inferred output is nameable from here. A
// deploy that declares `Paykit.providers()` carries it in the stack's
// requirements, and a declaration file cannot name it from `src/`.
export type { BillingStackShape } from "./BillingStack.resource.ts";

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

export type { D1Like, D1Prepared } from "./Store/D1.ts";

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
/**
 * The Effect Atom client: one runtime over a tenant layer, the two account
 * views as queries, and every tenant verb as a command that refreshes them.
 */
export * as Atom from "./Atom.ts";

/**
 * The binding surface as one namespace: `Paykit.Billing.TrackUsage(account)`.
 * This is the SDK a request handler uses. Every tag here is a
 * `Binding.Service`; the layers are below.
 *
 * One spelling per command: the binding is named for the command, and a command
 * *class* is exported as `<Name>Command`. A caller never has two names for one
 * thing.
 */
export * as Billing from "./Billing/index.ts";

// The tenant surface. A request handler uses these; each takes the account and
// returns the verb, so a call site cannot name a second account.
export {
  BillingApiLayer,
  Balances,
  BalancesLive,
  BalancesRead,
  Customers,
  CustomersLive,
  CustomersRead,
  SetBillingControls,
  GrantBalance,
  BillingInProcess,
  ChangeTier,
  ChargeProration,
  Check,
  CheckReadModel,
  CheckOverTransport,
  ConsumeCredits,
  Hold,
  List,
  Portal,
  Preview,
  ReleaseHold,
  Resume,
  ScheduleCancellation,
  ScheduleTierChange,
  SetUsage,
  SettleHold,
  StartTrial,
  Subscribe,
  TrackUsage,
  Webhook,
  WithdrawTierChange,
} from "./Billing/index.ts";

export type {
  BalancesError,
  BalancesRefusal,
  CustomersError,
  CustomersRefusal,
  CustomersVerb,
  CustomerUpdateRequest,
  SetBillingControlsError,
  SetBillingControlsRefusal,
  SetBillingControlsRequest,
  SetBillingControlsResult,
  SetBillingControlsVerb,
  BalancesVerb,
  BalanceCreateRequest,
  BalanceFinalizeRequest,
  BalanceGetRequest,
  BalanceNotFound,
  BalanceUpdateRequest,
  CancelError,
  GrantBalanceError,
  GrantBalanceRefusal,
  GrantBalanceRequest,
  GrantBalanceResult,
  GrantBalanceVerb,
  CancelRequest,
  ChangeTierError,
  ChangeTierRequest,
  ChangeTierResult,
  ChangeTierVerb,
  ChargeProrationError,
  ChargeProrationResult,
  ChargeProrationVerb,
  CheckError,
  CheckRequest,
  CheckVerb,
  ConsumeCreditsError,
  ConsumeCreditsRequest,
  ConsumeCreditsResult,
  ConsumeCreditsVerb,
  HoldError,
  HoldRequest,
  HoldResult,
  HoldVerb,
  ListError,
  ListVerb,
  PendingTierResult,
  PortalError,
  PortalResult,
  PortalVerb,
  PreviewError,
  PreviewRequest,
  PreviewVerb,
  ReleaseHoldError,
  ReleaseHoldRequest,
  ReleaseHoldResult,
  ReleaseHoldVerb,
  ResumeError,
  ResumeVerb,
  ScheduleTierChangeError,
  ScheduleTierChangeVerb,
  SetUsageError,
  SetUsageRefusal,
  SetUsageRequest,
  SetUsageResult,
  SetUsageVerb,
  SettleHoldError,
  SettleHoldRequest,
  SettleHoldResult,
  SettleHoldVerb,
  StandingResult,
  StartTrialError,
  StartTrialRequest,
  StartTrialResult,
  StartTrialVerb,
  SubscribeError,
  SubscribeRequest,
  SubscribeVerb,
  TrackUsageError,
  TrackUsageRequest,
  TrackUsageResult,
  TrackUsageVerb,
  WebhookApplyError,
  WebhookVerb,
  WithdrawTierChangeError,
  WithdrawTierChangeVerb,
} from "./Billing/index.ts";

// The operator surface, on its own layers. Deliberately not flat: an operator
// binding is something a console provides, not something an app imports.
export {
  BillingAdminApiLayer,
  BillingAdminInProcess,
  EnterGrace,
  Expire,
  ExtendTrial,
  GrantCredits,
  RecordPayment,
  RecordPaymentFailure,
  Recover,
  Refund,
} from "./Billing/index.ts";

export type {
  EnterGraceRequest,
  ExtendTrialRequest,
  GrantCreditsRequest,
  GrantCreditsResult,
  RecordPaymentFailureRequest,
  RecordPaymentRequest,
  RefundRequest,
  RefundResult,
  StandingSnapshot,
} from "./Billing/index.ts";

export { BindingCall, BindingFailed } from "./Billing/Bindings.ts";

export type { BindingError } from "./Billing/Bindings.ts";

// The contracts the bindings answer with, and the pieces they do not own.
export { CheckFailed, CheckStatus, CheckTransport, evaluateCheck, rowToState } from "./Check.ts";

export { httpStatus } from "./HttpStatus.ts";

export { handler, moneyRoutes } from "./Handler.ts";

export type {
  HandlerMount,
  HandlerOptions,
  HandlerRoute,
  HandlerSurfaces,
  MoneyRoutes,
} from "./Handler.ts";

export type { CheckInput, CheckResult } from "./Check.ts";

export { CheckLockKeyMissing } from "./Billing/Check.binding.ts";

export type { CheckRefusal } from "./Billing/Check.binding.ts";

export { SetUsage as SetUsageBinding } from "./Billing/SetUsage.binding.ts";

export { Proration, ProrationPeriod, prorate, unusedFraction } from "./Proration.ts";

export type { Proration as ProrationValue } from "./Proration.ts";

export type {
  PreviewCommand,
  PreviewEvent,
  PreviewInput,
  PreviewResult,
} from "./Billing/Preview.operation.ts";

export {
  WEBHOOK_PHASES,
  WEBHOOK_TRANSITIONS,
  WebhookAction,
  WebhookEvent,
  WebhookInvalid,
  WebhookKind,
  WebhookSignatureInvalid,
  webhookActionOf,
} from "./Webhooks.ts";

export type { PaymentsWebhook, WebhookError, WebhookRequest } from "./Webhooks.ts";

export {
  AccountEvent,
  TimelineCredits,
  TimelineEntry,
  TimelineFeature,
  TimelineKind,
  TimelinePeriod,
  UsageTimeline,
  appendTimeline,
  initialTimeline,
  timelineOf,
} from "./Timeline.ts";

export type { TimelineInput } from "./Timeline.ts";

export {
  planChangeTier,
  purchaseCreditsInputOf,
  scheduleTierChangeInputOf,
  schedulePlanChangeInputOf,
  subscribeInputOf,
  subscribePlanInputOf,
  withGrants,
} from "./TierCommand.ts";

export type { ChangeTierPlan, GrantedPlanInput, TierGrantInput } from "./TierCommand.ts";

export { CatalogService, catalogLayer } from "./CatalogService.ts";

export type { PaykitCatalogClientError, PaykitCatalogClientOptions } from "./CatalogRpc.ts";

export {
  CatalogUnavailable,
  PaykitCatalogClient,
  PaykitCatalogHandlers,
  PaykitCatalogRpcs,
  PaykitCatalogServer,
} from "./CatalogRpc.ts";

export { CatalogGuard, CatalogGuardLive, catalogMismatchOf } from "./CatalogGuard.ts";

export { CatalogMismatch } from "./CatalogMismatch.rejection.ts";

export {
  MissingProviderRef,
  OrphanProviderRef,
  TierHasNoPurchasePath,
  Verify,
  VerifyMismatch,
  verifyState,
} from "./Verify.ts";

export type { VerifyOptions } from "./Verify.ts";

// ── 3. model ────────────────────────────────────────────────────────────────
export { PaykitHandlers, PaykitModel, PaykitModel as Model } from "./Paykit.model.ts";

export { world } from "./World.ts";

export type { PaykitWorldOptions } from "./World.ts";

export { BillingApi } from "./BillingApi.api.ts";

export type { SubscribeInput, SubscribeResult } from "./Billing/Subscribe.operation.ts";

export { BillingAdminApi } from "./BillingAdminApi.api.ts";

export { Subscription, subscriptionRef } from "./Subscription/Subscription.aggregate.ts";

export { allowsOne } from "./Subscription/Entitlements.view.ts";

export type { JudgedFeature } from "./Subscription/Allowance.verdict.ts";

export { ProrationMismatch } from "./Subscription/ProrationMismatch.rejection.ts";

export {
  Period,
  Standing,
  SubscriptionStatus,
  initialSubscriptionState,
  periodFrom,
  standingOf,
  statusOf,
  topUpFailureOf,
} from "./Subscription/Subscription.state.ts";

export type {
  SubscribedState,
  SubscriptionState,
  TopUpFailureRecord,
  UnsubscribedState,
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

// ── auth ────────────────────────────────────────────────────────────────────
export {
  Actor,
  account as actorAccount,
  admin as actorAdmin,
  mayActOn,
  system,
} from "./Auth/Actor.ts";

export { ActorKind } from "./Auth/Actor.ts";

export type { ActorValue } from "./Auth/Actor.ts";

export { CrossOrigin } from "./Auth/CrossOrigin.rejection.ts";

export { Forbidden } from "./Auth/Forbidden.rejection.ts";

export { Unauthenticated } from "./Auth/Unauthenticated.rejection.ts";

export { Admin, Session } from "./Auth/Guards.ts";

export { AdminFrom, GuardsFrom, SessionFrom, authenticate } from "./Auth/FromResolver.ts";

export type { ActorResolver, FromResolverOptions, GuardRequest } from "./Auth/FromResolver.ts";

export {
  ACTOR_HEADER,
  InsecureAdminFromHeaders,
  InsecureDevGuards,
  InsecureSessionFromHeaders,
  KIND_HEADER,
  actorFromHeaders,
} from "./Auth/FromHeaders.ts";

export { AccountId } from "./Subscription/Subscription.id.ts";

export { AccountEvents } from "./Subscription/AccountEvents.stream.ts";

export { AccountEventsProjection } from "./Subscription/AccountEventsProjection.ts";

export { BillingRead } from "./Subscription/BillingRead.projection.ts";

export {
  PeriodCloseUsage,
  billableLines,
  periodUsageCommandId,
} from "./Subscription/PeriodCloseUsage.policy.ts";

export {
  AutoTopUp,
  AutoTopUpConfig,
  AutoTopUpInvalid,
  autoTopUp,
  crossedThreshold,
  packFor,
  topUpCommandId,
  topUpCooldownFor,
  topUpFailureCommandId,
  TopUpPackUnresolved,
} from "./Subscription/AutoTopUp.policy.ts";

export type { AutoTopUpPack, AutoTopUpTerms } from "./Subscription/AutoTopUp.policy.ts";

export { PeriodRollover } from "./Subscription/PeriodRollover.policy.ts";

export {
  ScheduleTierChange as ScheduleTierChangeCommand,
  PlanChangeScheduled,
} from "./Subscription/ScheduleTierChange.command.ts";

export {
  NoTierChangeScheduled,
  TierChangeWithdrawn,
  WithdrawTierChange as WithdrawTierChangeCommand,
} from "./Subscription/WithdrawTierChange.command.ts";

export type { PendingTier } from "./Subscription/Subscription.state.ts";

export {
  Dunning,
  DunningConfig,
  DunningInvalid,
  dunning,
  dunningChargeCommandId,
  dunningRetryCommandId,
} from "./Subscription/Dunning.policy.ts";

export type { DunningTerms } from "./Subscription/Dunning.policy.ts";

export { DunningRetry, DunningRetryDue } from "./Subscription/DunningRetry.command.ts";

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

export {
  TrialStarted,
  StartTrial as StartTrialCommand,
} from "./Subscription/StartTrial.command.ts";

export {
  PlanChanged,
  ChangeTier as ChangeTierCommand,
  DowngradeBelowUsage,
  DowngradeBelowSpend,
  DowngradeBelowCeiling,
} from "./Subscription/ChangeTier.command.ts";

export {
  AllowanceExceeded,
  CreditExceeded,
  FeatureNotMetered,
  MoneyCapExceeded,
  SpendCapExceeded,
  StandingBlocksUsage,
  TrackUsage as TrackUsageCommand,
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

export {
  SettleHold as SettleHoldCommand,
  UsageSettled,
} from "./Subscription/SettleHold.command.ts";

export {
  ReleaseHold as ReleaseHoldCommand,
  UsageReleased,
} from "./Subscription/ReleaseHold.command.ts";

export {
  PaymentRecorded,
  RecordPayment as RecordPaymentCommand,
} from "./Subscription/RecordPayment.command.ts";

export { CreditsPurchased } from "./Subscription/PurchaseCredits.command.ts";

export {
  RecordTopUpFailure as RecordTopUpFailureCommand,
  TopUpFailed,
} from "./Subscription/RecordTopUpFailure.command.ts";

export {
  RetryTopUp as RetryTopUpCommand,
  TopUpRetryDue,
} from "./Subscription/RetryTopUp.command.ts";

export {
  Refund as RefundCommand,
  RefundExceedsCharged,
  RefundRecorded,
} from "./Subscription/Refund.command.ts";

export {
  RefundNotFound,
  RefundReversed,
  RefundReversalExceedsRefunded,
  ReverseRefund as ReverseRefundCommand,
} from "./Subscription/ReverseRefund.command.ts";

export {
  TopUpCooldownCleared,
  TopUpCooldownElapsed,
} from "./Subscription/TopUpCooldownElapsed.command.ts";

export {
  PaymentFailed,
  RecordPaymentFailure as RecordPaymentFailureCommand,
} from "./Subscription/RecordPaymentFailure.command.ts";

export {
  AlreadyInGrace,
  EnterGrace as EnterGraceCommand,
  GraceDeadlineNotLater,
  GraceEntered,
} from "./Subscription/EnterGrace.command.ts";

export { Recover as RecoverCommand, Recovered } from "./Subscription/Recover.command.ts";

export {
  CreditsGranted,
  GrantCredits as GrantCreditsCommand,
} from "./Subscription/GrantCredits.command.ts";

export {
  ConsumeCredits as ConsumeCreditsCommand,
  CreditExceedsBalance,
  CreditsConsumed,
} from "./Subscription/ConsumeCredits.command.ts";

export {
  CancellationScheduled,
  ScheduleCancellation as ScheduleCancellationCommand,
} from "./Subscription/ScheduleCancellation.command.ts";

export { CancellationWithdrawn, Resume as ResumeCommand } from "./Subscription/Resume.command.ts";

export {
  ClosePeriod,
  CreditsExpired,
  PeriodClosed,
  PeriodNotClosed,
  UsageReset,
} from "./Subscription/ClosePeriod.command.ts";

export { Expire as ExpireCommand, SubscriptionExpired } from "./Subscription/Expire.command.ts";

export {
  CancelImmediately as CancelImmediatelyCommand,
  SubscriptionCanceled,
} from "./Subscription/CancelImmediately.command.ts";

export { GraceElapsed } from "./Subscription/GraceElapsed.command.ts";

export { DunningRetry as DunningRetryCommand } from "./Subscription/DunningRetry.command.ts";

export { PeriodEnded } from "./Subscription/PeriodEnded.command.ts";

export {
  ExtendTrial as ExtendTrialCommand,
  TrialExtended,
  TrialNotActive,
} from "./Subscription/ExtendTrial.command.ts";

export {
  AttachProviderRef,
  ProviderRefAttached,
} from "./Subscription/AttachProviderRef.command.ts";

export {
  NoProrationDue,
  ProrationInvoiced,
  ProrationInvoiceMismatch,
  RecordProrationInvoice,
} from "./Subscription/RecordProrationInvoice.command.ts";

export { AlreadyCanceled } from "./Subscription/AlreadyCanceled.rejection.ts";

export { AlreadySubscribed } from "./Subscription/AlreadySubscribed.rejection.ts";

export { CurrencyMismatch } from "./Subscription/CurrencyMismatch.rejection.ts";

export { NotInGrace } from "./Subscription/NotInGrace.rejection.ts";

export { NotScheduled } from "./Subscription/NotScheduled.rejection.ts";

export { NotSubscribed } from "./Subscription/NotSubscribed.rejection.ts";

export { StandingEnded } from "./Subscription/StandingEnded.rejection.ts";

export { PlanNotInCatalog } from "./Subscription/PlanNotInCatalog.rejection.ts";

export { PlanPhaseNotFuture } from "./Subscription/PlanPhaseNotFuture.rejection.ts";

export { PlanPhaseNamesAddOn } from "./Subscription/PlanPhaseNamesAddOn.rejection.ts";

export { TrialAlreadyUsed } from "./Subscription/TrialAlreadyUsed.rejection.ts";

export { PlanItemReset, ResetAllowance } from "./Subscription/ResetAllowance.command.ts";

export { FeatureNotConsumable } from "./Subscription/FeatureNotConsumable.rejection.ts";

export {
  QuantityCapExceeded,
  QuantityChanged,
  QuantityExceeded,
  QuantityInvalid,
  QuantityProrationAlreadyBilled,
  SetQuantity,
} from "./Subscription/SetQuantity.command.ts";

export {
  SetUsage as SetUsageCommand,
  UsageInvalid,
  UsageSet,
} from "./Subscription/SetUsage.command.ts";

export {
  BillingControlsSet,
  ControlFeature,
  ControlsDuplicate,
  ControlsFeatureNotPriced,
  ControlsFeatureUnknown,
  SetBillingControls as SetBillingControlsCommand,
} from "./Subscription/SetBillingControls.command.ts";

export { SpendLimitExceeded } from "./Subscription/SpendLimitExceeded.rejection.ts";

export { UsageAlertFired } from "./Subscription/UsageAlertFired.event.ts";

export {
  BalanceGranted,
  FeatureNotCounted,
  GrantBalance as GrantBalanceCommand,
  GrantExpiryNotLater,
} from "./Subscription/GrantBalance.command.ts";

export {
  BalanceExpired,
  ExpireGrant as ExpireGrantCommand,
} from "./Subscription/ExpireGrant.command.ts";

export {
  AttachEntity as AttachEntityCommand,
  EntityAttached,
} from "./Subscription/AttachEntity.command.ts";

export {
  EntityUpdated,
  UpdateEntity as UpdateEntityCommand,
} from "./Subscription/UpdateEntity.command.ts";

export {
  ArchiveEntity as ArchiveEntityCommand,
  EntityArchivedEvent,
  ReturnedQuantity,
  ReturnedSource,
} from "./Subscription/ArchiveEntity.command.ts";

export {
  BalanceTransferred,
  TransferBalance as TransferBalanceCommand,
  TransferExceedsBalance,
  TransferOfCreditSystem,
  TransferOfPooledSource,
} from "./Subscription/TransferBalance.command.ts";

export { EntityArchived } from "./Subscription/EntityArchived.rejection.ts";

export { EntityExists } from "./Subscription/EntityExists.rejection.ts";

export { EntityHasOccupancy } from "./Subscription/EntityHasOccupancy.rejection.ts";

export { EntityUnknown } from "./Subscription/EntityUnknown.rejection.ts";

export { FeaturePricedInCredits } from "./Subscription/FeaturePricedInCredits.rejection.ts";

export { PooledItemOnEntity } from "./Subscription/PooledItemOnEntity.rejection.ts";

export {
  NoQuantityProrationDue,
  QuantityProrationInvoiced,
  QuantityProrationMismatch,
  QuantityProrationNotBillable,
  RecordQuantityProrationInvoice,
} from "./Subscription/QuantityProration.command.ts";

export { TrialDeadlineNotLater } from "./Subscription/TrialDeadlineNotLater.rejection.ts";

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

export { PaymentsPolar, resolvePolarProductId } from "./PaymentsPolar.ts";

export type { PolarBindings, PolarProductId, PolarProps, PolarTier } from "./PaymentsPolar.ts";

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

export { UsageLine } from "./Payments.ts";

export type { PricedUnits } from "./Subscription/Entitlements.view.ts";

export { planItemsOf, planOf, planTermsOf } from "./Catalog.ts";
