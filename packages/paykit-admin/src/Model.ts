import type { AdminAction } from "@potion.run/paykit/Admin";
import { BillingReadRow } from "@potion.run/paykit/BillingReadStore";
import { Catalog } from "@potion.run/paykit/Catalog";
import { CommandIds } from "@potion.run/paykit/Foldkit";
import { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import {
  AccountId,
  Standing,
  SubscriptionStatus,
} from "@potion.run/paykit/Subscription/Subscription.state";
import * as Schema from "effect/Schema";

export const LoadState = Schema.Literals(["Idle", "Loading", "Loaded", "Failed"]);
export type LoadState = typeof LoadState.Type;

export const FeedState = Schema.Literals(["CatchingUp", "Live", "Failed"]);
export type FeedState = typeof FeedState.Type;

/** The server-side filters the list accepts. Empty means "all". */
export const AccountFilter = Schema.Struct({
  standing: Schema.Option(Standing),
  status: Schema.Option(SubscriptionStatus),
  tier: Schema.Option(Schema.String),
});
export type AccountFilter = typeof AccountFilter.Type;

export const EventRow = Schema.Struct({
  seq: Schema.Int,
  at: Schema.DateTimeUtc,
  commandId: Schema.String,
  tag: Schema.String,
  body: Schema.String,
});
export type EventRow = typeof EventRow.Type;

/** What the operator asked for, after parsing and before sending a command. */
export const AdminIntent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("GrantCredits"), amount: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("ExtendTrial"), trialEndsAt: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal("EnterGrace"), graceUntil: Schema.DateTimeUtc }),
  Schema.Struct({
    kind: Schema.Literal("RecordPayment"),
    amount: Schema.Int,
    currency: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("RecordPaymentFailure"),
    reason: Schema.String,
    graceUntil: Schema.DateTimeUtc,
  }),
  Schema.Struct({ kind: Schema.Literal("Recover") }),
  Schema.Struct({ kind: Schema.Literal("Expire") }),
  Schema.Struct({ kind: Schema.Literal("ScheduleCancellation") }),
  Schema.Struct({ kind: Schema.Literal("Resume") }),
]);
export type AdminIntent = typeof AdminIntent.Type;

/** The form strings for one open action. Parsed into an `AdminIntent` on submit. */
export const ActionDraft = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("GrantCredits"), amount: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("ExtendTrial"), trialEndsAt: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("EnterGrace"), graceUntil: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("RecordPayment"),
    amount: Schema.String,
    currency: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("RecordPaymentFailure"),
    reason: Schema.String,
    graceUntil: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("Recover") }),
  Schema.Struct({ kind: Schema.Literal("Expire") }),
  Schema.Struct({ kind: Schema.Literal("ScheduleCancellation") }),
  Schema.Struct({ kind: Schema.Literal("Resume") }),
]);
export type ActionDraft = typeof ActionDraft.Type;

export const PendingStatus = Schema.Literals([
  "Sending",
  "Unknown",
  "Accepted",
  "Rejected",
  "Denied",
]);
export type PendingStatus = typeof PendingStatus.Type;

export const Pending = Schema.Struct({
  commandId: Schema.String,
  intent: AdminIntent,
  status: PendingStatus,
  reason: Schema.Option(Schema.String),
});
export type Pending = typeof Pending.Type;

export const AccountState = Schema.Struct({
  id: AccountId,
  billing: Schema.Option(BillingStateView),
  entitlements: Schema.Option(EntitlementsState),
  events: Schema.Array(EventRow),
  cursor: Schema.Option(Schema.Int),
  feed: FeedState,
  error: Schema.Option(Schema.String),
  draft: Schema.Option(ActionDraft),
  pending: Schema.Array(Pending),
  notice: Schema.Option(Schema.String),
});
export type AccountState = typeof AccountState.Type;

export const AccountsState = Schema.Struct({
  rows: Schema.Array(BillingReadRow),
  next: Schema.Option(Schema.String),
  filter: AccountFilter,
  state: LoadState,
  error: Schema.Option(Schema.String),
  requestId: Schema.Option(Schema.Int),
});
export type AccountsState = typeof AccountsState.Type;

export const Model = Schema.Struct({
  session: Schema.String,
  actor: Schema.Option(Schema.Struct({ id: Schema.String, kind: Schema.String })),
  commandIds: CommandIds,
  queryIds: Schema.Struct({ sent: Schema.Int }),
  catalog: Schema.Option(Catalog),
  catalogError: Schema.Option(Schema.String),
  accounts: AccountsState,
  account: Schema.Option(AccountState),
});
export type Model = typeof Model.Type;

/** The action names the console can currently send. `ChangeTier` waits for a server quote. */
export const ConsoleAction: ReadonlyArray<AdminAction> = [
  "GrantCredits",
  "ExtendTrial",
  "EnterGrace",
  "RecordPayment",
  "RecordPaymentFailure",
  "Recover",
  "Expire",
  "ScheduleCancellation",
  "Resume",
];
