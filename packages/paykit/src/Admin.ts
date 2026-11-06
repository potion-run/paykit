/**
 * The ops console's first-class read contract, separate from the tenant and
 * admin Domain Apis. `List`, `Preview` and `Verify` are bindings over the
 * model, not keyed Api reads, and a cross-account list cannot be a view.
 *
 * Every RPC in `AdminReadsRpcs` runs through `Admin`, so a console endpoint is
 * never a wider surface than the admin commands it sits beside.
 */
export {
  AdminReads,
  AdminReadsClient,
  AdminReadsHandlers,
  AdminReadFailed,
  AdminReadsLive,
  AdminReadError,
  AdminReadsRpcs,
  AdminPreviewInput,
  BillingOverview,
  HoldsAnswer,
  ProviderRefsAnswer,
  RevenueSummary,
  PreviewAccepted,
  PreviewAnswer,
  PreviewCommandSchema,
  PreviewEvents,
  PreviewRejection,
  PreviewRejected,
  PreviewUnpredictable,
  makeAdminReads,
  previewAnswerOf,
} from "./Admin/Reads.ts";
export type { AdminReadsShape } from "./Admin/Reads.ts";
export {
  AdminChangeTier,
  AdminChangeTierClient,
  AdminChangeTierHandlers,
  AdminChangeTierLive,
  ChangeTierRequote,
  ChangeTierRejected,
  AdminChangeTierRpcs,
  ChangeTierApplied,
  ChangeTierFailed,
  ChangeTierQuoted,
  ChangeTierAnswer,
  ChangeTierRejection,
  AdminConsoleRpcs,
  ChangeTierRequest,
  makeAdminChangeTier,
} from "./Admin/ChangeTier.ts";
export type { AdminChangeTierShape } from "./Admin/ChangeTier.ts";
export { AdminConsoleServer } from "./Admin/Server.ts";
export { AdminAction, actionsFor } from "./AdminActions.ts";
export type { AdminActionDescriptor } from "./AdminActions.ts";
