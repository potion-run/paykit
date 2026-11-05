import { AdminAction, PreviewCommandSchema } from "@potion.run/paykit/Admin";
import { AdminChangeCommands, AdminQueries, BillingAdmin } from "@potion.run/paykit/Foldkit";
import { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import { AccountId } from "@potion.run/paykit/Subscription/Subscription.state";
import { AccountEvent } from "@potion.run/paykit/Timeline";
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import { DevToolsTab } from "./DevTools.ts";

export const Message = defineMessageUnion({
  ClickedRefresh: {},
  ClickedNextPage: {},
  UpdatedStandingFilter: { value: Schema.String },
  UpdatedStatusFilter: { value: Schema.String },
  UpdatedTierFilter: { value: Schema.String },
  ClickedAccount: { account: AccountId },
  ClosedAccount: {},

  /** The runtime's `routing.onUrlChange`: a push, a replace, or a back button. */
  ChangedUrl: { url: Url },
  /** The runtime's `routing.onUrlRequest`: a link the console did not draw. */
  ClickedLink: { request: UrlRequest },
  CompletedReflectRoute: {},
  CompletedLoadExternal: {},

  ReceivedAdminQuery: { message: AdminQueries.Message },
  ReceivedAdminResult: { message: BillingAdmin.Message },
  ReceivedAdminChange: { message: AdminChangeCommands.Message },

  ReceivedBilling: { state: Schema.Option(BillingStateView) },
  ReceivedEntitlements: { state: Schema.Option(EntitlementsState) },
  ReceivedEvent: {
    seq: Schema.Int,
    at: Schema.DateTimeUtc,
    commandId: Schema.String,
    tag: Schema.String,
    body: Schema.String,
    event: AccountEvent,
  },
  CaughtUpEvents: { cursor: Schema.Int },
  FailedEvents: { reason: Schema.String },
  FailedAccountWatch: { reason: Schema.String },

  ClickedAction: { action: AdminAction },
  UpdatedDraftField: { field: Schema.String, value: Schema.String },
  ClickedSubmitAction: {},
  ClickedConfirmChangeTier: {},
  ClickedCancelAction: {},
  ClickedRetryPending: { commandId: Schema.String },
  DismissedNotice: {},

  UpdatedPreviewTier: { value: Schema.String },
  ClickedPreview: { command: PreviewCommandSchema },
  DismissedPreview: {},
  ClickedVerify: {},
  DismissedVerify: {},

  ToggledDevTools: { isOpen: Schema.Boolean },
  SelectedDevToolsTab: { tab: DevToolsTab },
  UpdatedDevToolsAccountId: { value: Schema.String },
  ClickedOpenDevToolsAccount: {},
  UpdatedDevToolsEventTag: { value: Schema.String },
  UpdatedDevToolsEventBody: { value: Schema.String },
  UpdatedDevToolsCommandId: { value: Schema.String },
  ClickedEmitDevToolsEvent: {},
  ClickedEmitAllDevToolsEvents: {},
  ClickedSeedDevToolsSnapshot: {},
  ClickedCatchUpDevToolsFeed: {},
  ClickedFailDevToolsFeed: {},
  ClickedFailDevToolsReads: {},
  ClickedResetDevTools: {},
});
export type Message = typeof Message.Type;
