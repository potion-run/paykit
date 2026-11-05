import type { AdminAction } from "@potion.run/paykit/Admin";
import { Forbidden } from "@potion.run/paykit/Auth/Forbidden.rejection";
import { Unauthenticated } from "@potion.run/paykit/Auth/Unauthenticated.rejection";
import { BillingAdminApi } from "@potion.run/paykit/BillingAdminApi.api";
import { BillingReadRow } from "@potion.run/paykit/BillingReadStore";
import { Catalog } from "@potion.run/paykit/Catalog";
import { CommandIds } from "@potion.run/paykit/Foldkit";
import { Proration } from "@potion.run/paykit/Proration";
import { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import { AccountId } from "@potion.run/paykit/Subscription/Subscription.state";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountFilter, ConsoleRoute } from "./Route.ts";

export { AccountFilter } from "./Route.ts";

export const LoadState = Schema.Literals(["Idle", "Loading", "Loaded", "Failed"]);
export type LoadState = typeof LoadState.Type;

export const FeedState = Schema.Literals(["CatchingUp", "Live", "Failed"]);
export type FeedState = typeof FeedState.Type;

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
  Schema.Struct({ kind: Schema.Literal("ChangeTier"), tier: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("ScheduleTierChange"), tier: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("WithdrawTierChange") }),
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
  Schema.Struct({ kind: Schema.Literal("ChangeTier"), tier: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("ScheduleTierChange"), tier: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("WithdrawTierChange") }),
]);
export type ActionDraft = typeof ActionDraft.Type;

/** One tier-change flow: quoting, quoted, or applying a quoted amount. */
export const ChangeTierQuoting = Schema.TaggedStruct("Quoting", {
  requestId: Schema.Int,
  tier: Schema.String,
});

export const ChangeTierQuoted = Schema.TaggedStruct("Quoted", {
  requestId: Schema.Int,
  tier: Schema.String,
  proration: Schema.NullOr(Proration),
});

export const ChangeTierApplying = Schema.TaggedStruct("Applying", {
  requestId: Schema.Int,
  tier: Schema.String,
  proration: Schema.NullOr(Proration),
  commandId: Schema.String,
});

export const ChangeTierQuote = Schema.Union([
  ChangeTierQuoting,
  ChangeTierQuoted,
  ChangeTierApplying,
]);
export type ChangeTierQuote = typeof ChangeTierQuote.Type;

export const PendingStatus = Schema.Literals([
  "Sending",
  "Unknown",
  "Accepted",
  "Rejected",
  "Denied",
]);
export type PendingStatus = typeof PendingStatus.Type;

/** The typed evidence a command failed with, kept for the operator to read. */
export const AdminRejected = Schema.TaggedStruct("Rejected", {
  rejection: BillingAdminApi.rejections,
});

export const AdminDenied = Schema.TaggedStruct("Denied", {
  error: Schema.Union([Unauthenticated, Forbidden]),
});

export const AdminUnknown = Schema.TaggedStruct("Unknown", {});

export const AdminFailure = Schema.Union([AdminRejected, AdminDenied, AdminUnknown]);
export type AdminFailure = typeof AdminFailure.Type;

export const Pending = Schema.Struct({
  commandId: Schema.String,
  intent: AdminIntent,
  status: PendingStatus,
  reason: Schema.Option(Schema.String),
  failure: Schema.Option(AdminFailure),
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
  change: Schema.Option(ChangeTierQuote),
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
  /**
   * When the store answered the page on screen. `None` means the rows came
   * from a snapshot with no stamp, so the console says "provenance unknown"
   * rather than claiming they are current.
   */
  asOf: Schema.Option(Schema.DateTimeUtc),
});
export type AccountsState = typeof AccountsState.Type;

export const Model = Schema.Struct({
  session: Schema.String,
  actor: Schema.Option(Schema.Struct({ id: Schema.String, kind: Schema.String })),
  commandIds: CommandIds,
  queryIds: Schema.Struct({ sent: Schema.Int }),
  catalog: Schema.Option(Catalog),
  catalogError: Schema.Option(Schema.String),
  /** What the address bar names. The Model follows the URL, not the reverse. */
  route: ConsoleRoute,
  accounts: AccountsState,
  account: Schema.Option(AccountState),
});
export type Model = typeof Model.Type;

/** The state of an account nothing has been read for yet. */
export const openedAccount = (id: AccountId): AccountState => ({
  id,
  billing: Option.none(),
  entitlements: Option.none(),
  events: [],
  cursor: Option.none(),
  feed: "CatchingUp",
  error: Option.none(),
  draft: Option.none(),
  change: Option.none(),
  pending: [],
  notice: Option.none(),
});

/** The action names the console can currently send. `ChangeTier` waits for a server quote. */
export const ConsoleAction: ReadonlyArray<AdminAction> = [
  "GrantCredits",
  "ExtendTrial",
  "ChangeTier",
  "EnterGrace",
  "RecordPayment",
  "RecordPaymentFailure",
  "Recover",
  "Expire",
  "ScheduleCancellation",
  "Resume",
  "ScheduleTierChange",
  "WithdrawTierChange",
];
