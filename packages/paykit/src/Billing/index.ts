/**
 * The runtime binding surface, in one import: `@potion.run/paykit/Billing`.
 *
 * One `Binding.Service` per command and per operation, named for what it does.
 * `yield* Paykit.TrackUsage(account)` binds the account and returns the verb;
 * the verb takes the rest. [ADR 0015](../../../docs/adr/0015-a-runtime-binding-names-a-command.md)
 * is the record.
 *
 * This barrel is separate from the package root so the retirement of
 * `Track` / `Hold` / `Settle` / `Release` can be one commit that deletes the old
 * names and re-points the root — the package never ships two spellings of one
 * command in the same namespace.
 *
 * ```typescript
 * import { BillingInProcess, TrackUsage } from "@potion.run/paykit/Billing";
 *
 * fetch: Effect.gen(function* () {
 *   const trackUsage = yield* TrackUsage(account);
 *   yield* trackUsage({ featureId: "messages", value: 1, idempotencyKey: requestId });
 * }).pipe(Effect.provide(Layer.mergeAll(BillingInProcess, catalogLayer(Catalog))));
 * ```
 */

// ── the shared vocabulary of a binding ──────────────────────────────────────
export { BindingCall, BindingFailed, type BindingError } from "./Bindings.ts";

// ── command bindings, served by both layers ────────────────────────────────
export {
  Attach,
  AttachInProcess,
  Update,
  UpdateInProcess,
  PreviewAttach,
  PreviewAttachInProcess,
  PreviewUpdate,
  PreviewUpdateInProcess,
  PlanOperationUnsupported,
  type CancelAction,
  type AttachError,
  AttachRequest,
  type AttachResult,
  type AttachVerb,
  type UpdateError,
  UpdateRequest,
  type UpdateResult,
  type UpdateVerb,
  type PreviewAttachError,
  PreviewAttachRequest,
  type PreviewAttachResult,
  type PreviewAttachVerb,
  type PreviewUpdateError,
  PreviewUpdateRequest,
  type PreviewUpdateResult,
  type PreviewUpdateVerb,
  type FeatureQuantity,
  type PlanSchedule,
  type ProrationBehavior,
} from "./Attach.binding.ts";

export {
  Check,
  CheckLockKeyMissing,
  type CheckError,
  type CheckRefusal,
  type CheckRequest,
  type CheckVerb,
} from "./Check.binding.ts";

export {
  Customers,
  type CustomersError,
  type CustomersRefusal,
  type CustomersVerb,
  type CustomerUpdateRequest,
  isCustomersRefusal,
  toCustomersError,
} from "./Customers.binding.ts";

export { CustomersLive, CustomersRead } from "./Customers.layer.ts";

export {
  SetBillingControls,
  type SetBillingControlsError,
  type SetBillingControlsRefusal,
  type SetBillingControlsRequest,
  type SetBillingControlsResult,
  type SetBillingControlsVerb,
  controlFeaturesOf,
  isSetBillingControlsRefusal,
  toSetBillingControlsError,
} from "./SetBillingControls.binding.ts";

export {
  BalanceCreateRequest,
  BalanceFinalizeRequest,
  BalanceGetRequest,
  BalanceListRequest,
  BalanceNotFound,
  BalanceUpdateRequest,
  Balances,
  type BalancesError,
  type BalancesRefusal,
  type BalancesVerb,
} from "./Balances.binding.ts";

export { BalancesLive, BalancesRead, toBalancesReadError } from "./Balances.layer.ts";

export {
  Entities,
  EntityArchiveRequest,
  EntityCreateRequest,
  EntityUpdateRequest,
  type EntitiesError,
  type EntitiesRefusal,
  type EntitiesVerb,
  isEntitiesRefusal,
  toEntitiesError,
} from "./Entities.binding.ts";

export { EntitiesLive, EntitiesRead, EntityWrites } from "./Entities.layer.ts";

export {
  TransferBalance,
  TransferBalanceRequest,
  TransferBalanceResult,
  TransferCrossCustomer,
  type TransferBalanceError,
  type TransferBalanceRefusal,
  type TransferBalanceVerb,
  isTransferBalanceRefusal,
  toTransferBalanceError,
} from "./TransferBalance.binding.ts";

export { TransferBalanceLive, TransferBalanceWrite } from "./TransferBalance.layer.ts";

export {
  GrantBalance,
  isGrantBalanceRefusal,
  toGrantBalanceError,
  type GrantBalanceError,
  type GrantBalanceRefusal,
  type GrantBalanceRequest,
  type GrantBalanceResult,
  type GrantBalanceVerb,
} from "./GrantBalance.binding.ts";

export {
  TrackUsage,
  type TrackUsageError,
  type TrackUsageRequest,
  type TrackUsageResult,
  type TrackUsageVerb,
} from "./TrackUsage.binding.ts";

export {
  Hold,
  type HoldError,
  type HoldRequest,
  type HoldResult,
  type HoldVerb,
} from "./Hold.binding.ts";

export {
  SettleHold,
  type SettleHoldError,
  type SettleHoldRequest,
  type SettleHoldResult,
  type SettleHoldVerb,
} from "./SettleHold.binding.ts";

export {
  ReleaseHold,
  type ReleaseHoldError,
  type ReleaseHoldRequest,
  type ReleaseHoldResult,
  type ReleaseHoldVerb,
} from "./ReleaseHold.binding.ts";

export {
  ConsumeCredits,
  type ConsumeCreditsError,
  type ConsumeCreditsRequest,
  type ConsumeCreditsResult,
  type ConsumeCreditsVerb,
} from "./ConsumeCredits.binding.ts";

export {
  Resume,
  ScheduleCancellation,
  type CancelError,
  type CancelRefusal,
  type CancelRequest,
  type ResumeError,
  type ResumeVerb,
  type StandingResult,
} from "./Cancel.binding.ts";

export {
  ScheduleTierChange,
  WithdrawTierChange,
  type PendingTierResult,
  type ScheduleTierChangeError,
  type ScheduleTierChangeVerb,
  type WithdrawTierChangeError,
  type WithdrawTierChangeVerb,
} from "./ScheduleTierChange.binding.ts";

export {
  StartTrial,
  type StartTrialError,
  type StartTrialRequest,
  type StartTrialResult,
  type StartTrialVerb,
} from "./StartTrial.binding.ts";

// ── operation bindings, served by the process that owns the model ──────────
export {
  ChangeTier,
  type ChangeTierError,
  type ChangeTierRequest,
  type ChangeTierResult,
  type ChangeTierVerb,
} from "./ChangeTier.binding.ts";

export {
  Subscribe,
  type SubscribeError,
  type SubscribeRequest,
  type SubscribeVerb,
} from "./Subscribe.binding.ts";

export {
  Preview,
  type PreviewError,
  type PreviewRequest,
  type PreviewVerb,
} from "./Preview.binding.ts";

export {
  ChargeProration,
  Portal,
  type ChargeProrationError,
  type ChargeProrationResult,
  type ChargeProrationVerb,
  type PortalError,
  type PortalResult,
  type PortalVerb,
} from "./Portal.binding.ts";

export { List, type ListError, type ListVerb } from "./List.binding.ts";

export { Webhook, type WebhookApplyError, type WebhookVerb } from "./Webhook.binding.ts";

// ── the operator surface, served by its own layer ───────────────────────────
export {
  EnterGrace,
  Expire,
  ExtendTrial,
  GrantCredits,
  RecordPayment,
  RecordPaymentFailure,
  Recover,
  Refund,
  type AdminRequest,
  type EnterGraceError,
  type EnterGraceRequest,
  type EnterGraceVerb,
  type ExpireError,
  type ExpireVerb,
  type ExtendTrialError,
  type ExtendTrialRequest,
  type ExtendTrialVerb,
  type GrantCreditsError,
  type GrantCreditsRequest,
  type GrantCreditsResult,
  type GrantCreditsVerb,
  type RecordPaymentError,
  type RecordPaymentFailureError,
  type RecordPaymentFailureRequest,
  type RecordPaymentFailureVerb,
  type RecordPaymentRequest,
  type RecordPaymentVerb,
  type RecoverError,
  type RecoverVerb,
  type RefundError,
  type RefundRequest,
  type RefundResult,
  type RefundVerb,
  type StandingSnapshot,
} from "./Admin.binding.ts";

// ── the four layers ────────────────────────────────────────────────────────
export { BillingInProcess } from "./BillingInProcess.layer.ts";

export { CheckReadModel } from "./CheckReadModel.layer.ts";

export { CheckOverTransport } from "./CheckOverTransport.layer.ts";

export { BillingApiLayer } from "./BillingApi.layer.ts";

export { BillingAdminInProcess } from "./BillingAdminInProcess.layer.ts";

export { BillingAdminApiLayer } from "./BillingAdminApi.layer.ts";

export {
  SetUsage,
  isSetUsageRefusal,
  toSetUsageError,
  type SetUsageError,
  type SetUsageRefusal,
  type SetUsageRequest,
  type SetUsageResult,
  type SetUsageVerb,
} from "./SetUsage.binding.ts";

export {
  SetQuantity,
  isSetQuantityRefusal,
  toSetQuantityError,
  type SetQuantityError,
  type SetQuantityRefusal,
  type SetQuantityRequest,
  type SetQuantityResult,
  type SetQuantityVerb,
} from "./SetQuantity.binding.ts";

export {
  ChargeQuantityProration,
  chargeQuantityProrationOperation,
  isChargeQuantityProrationRefusal,
  toChargeQuantityProrationError,
  type ChargeQuantityProrationError,
  type ChargeQuantityProrationRefusal,
  type ChargeQuantityProrationRequest,
  type ChargeQuantityProrationResult,
  type ChargeQuantityProrationVerb,
} from "./ChargeQuantityProration.binding.ts";
