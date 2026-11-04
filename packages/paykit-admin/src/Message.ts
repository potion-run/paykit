import { AdminAction } from "@potion.run/paykit/Admin";
import { AdminQueries, BillingAdmin } from "@potion.run/paykit/Foldkit";
import { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import { AccountId } from "@potion.run/paykit/Subscription/Subscription.state";
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";

export const Message = defineMessageUnion({
  ClickedRefresh: {},
  ClickedNextPage: {},
  UpdatedStandingFilter: { value: Schema.String },
  UpdatedStatusFilter: { value: Schema.String },
  UpdatedTierFilter: { value: Schema.String },
  ClickedAccount: { account: AccountId },
  ClosedAccount: {},

  ReceivedAdminQuery: { message: AdminQueries.Message },
  ReceivedAdminResult: { message: BillingAdmin.Message },

  ReceivedBilling: { state: Schema.Option(BillingStateView) },
  ReceivedEntitlements: { state: Schema.Option(EntitlementsState) },
  ReceivedEvent: {
    seq: Schema.Int,
    at: Schema.DateTimeUtc,
    commandId: Schema.String,
    tag: Schema.String,
    body: Schema.String,
  },
  CaughtUpEvents: { cursor: Schema.Int },
  FailedEvents: { reason: Schema.String },
  FailedAccountWatch: { reason: Schema.String },

  ClickedAction: { action: AdminAction },
  UpdatedDraftField: { field: Schema.String, value: Schema.String },
  ClickedSubmitAction: {},
  ClickedCancelAction: {},
  ClickedRetryPending: { commandId: Schema.String },
  DismissedNotice: {},
});
export type Message = typeof Message.Type;
