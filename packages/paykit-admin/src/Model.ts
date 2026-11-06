import type { AdminAction } from "@potion.run/paykit/Admin";
import { BillingOverview, PreviewAnswer, PreviewCommandSchema } from "@potion.run/paykit/Admin";
import { Forbidden } from "@potion.run/paykit/Auth/Forbidden.rejection";
import { Unauthenticated } from "@potion.run/paykit/Auth/Unauthenticated.rejection";
import { BillingAdminApi } from "@potion.run/paykit/BillingAdminApi.api";
import { BillingReadRow } from "@potion.run/paykit/BillingReadStore";
import { Catalog } from "@potion.run/paykit/Catalog";
import { CommandIds } from "@potion.run/paykit/Foldkit";
import { Proration } from "@potion.run/paykit/Proration";
import { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import { AccountId, HoldRecord, Refs } from "@potion.run/paykit/Subscription/Subscription.state";
import { UsageTimeline, initialTimeline } from "@potion.run/paykit/Timeline";
import { VerifyMismatch } from "@potion.run/paykit/Verify";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ActionDraft, AdminIntent } from "./actions.ts";
import { DevToolsState } from "./DevTools.ts";
import { AccountFilter, ConsoleRoute } from "./Route.ts";

export { AccountFilter } from "./Route.ts";

export const LoadState = Schema.Literals(["Idle", "Loading", "Loaded", "Failed"]);
export type LoadState = typeof LoadState.Type;

/** A one-shot question: asked, answered, or failed. */
export const AnswerState = Schema.Literals(["Loading", "Answered", "Failed"]);
export type AnswerState = typeof AnswerState.Type;

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

export { ActionDraft, AdminIntent };

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

/**
 * One account's holds, as the aggregate records them. A hold is an entity, not
 * a count: the views fold it into `reserved`, and this is what an operator can
 * see by id, feature and deadline. A one-shot read, stamped like a list.
 */
export const HoldsState = Schema.Struct({
  requestId: Schema.Int,
  account: Schema.String,
  state: LoadState,
  asOf: Schema.Option(Schema.DateTimeUtc),
  holds: Schema.Array(HoldRecord),
  error: Schema.Option(Schema.String),
});
export type HoldsState = typeof HoldsState.Type;

/**
 * One account's vendor ids, per provider. Refs are entities the aggregate
 * records, not a fold, so an operator reads them as a stamped snapshot.
 */
export const ProviderRefsState = Schema.Struct({
  requestId: Schema.Int,
  account: Schema.String,
  state: LoadState,
  asOf: Schema.Option(Schema.DateTimeUtc),
  refs: Refs,
  error: Schema.Option(Schema.String),
});
export type ProviderRefsState = typeof ProviderRefsState.Type;

/** A cross-account dashboard read, with the request that asked for it. */
export const OverviewState = Schema.Struct({
  requestId: Schema.Int,
  state: LoadState,
  asOf: Schema.Option(Schema.DateTimeUtc),
  overview: Schema.Option(BillingOverview),
  error: Schema.Option(Schema.String),
});
export type OverviewState = typeof OverviewState.Type;

/** What `decide` would do with a command, asked without recording it. */
export const PreviewState = Schema.Struct({
  requestId: Schema.Int,
  account: Schema.String,
  command: PreviewCommandSchema,
  state: AnswerState,
  answer: Schema.Option(PreviewAnswer),
  error: Schema.Option(Schema.String),
});
export type PreviewState = typeof PreviewState.Type;

/** One account judged against the deploy's catalog and provider. */
export const VerifyState = Schema.Struct({
  requestId: Schema.Int,
  account: Schema.String,
  state: AnswerState,
  mismatches: Schema.Array(VerifyMismatch),
  error: Schema.Option(Schema.String),
});
export type VerifyState = typeof VerifyState.Type;

export const AccountState = Schema.Struct({
  id: AccountId,
  billing: Schema.Option(BillingStateView),
  entitlements: Schema.Option(EntitlementsState),
  events: Schema.Array(EventRow),
  /**
   * The billing facts the event feed has carried, folded as they arrive. A
   * pure fold (`@potion.run/paykit/Timeline`), never a stored read model: the
   * account stream is the log, and this is the slice a bill is read from.
   */
  timeline: UsageTimeline,
  cursor: Schema.Option(Schema.Int),
  feed: FeedState,
  error: Schema.Option(Schema.String),
  draft: Schema.Option(ActionDraft),
  change: Schema.Option(ChangeTierQuote),
  pending: Schema.Array(Pending),
  notice: Schema.Option(Schema.String),
  /** The holds the allowance view folds into `reserved` counts. */
  holds: Schema.Option(HoldsState),
  /** The vendor ids attached to this account, one entry per provider. */
  providerRefs: Schema.Option(ProviderRefsState),
  /** What the model would do, asked by the operator. */
  preview: Schema.Option(PreviewState),
  /** The tier the preview form would ask about, before it is asked. */
  previewTier: Schema.Option(Schema.String),
  /** Drift between this account and the deploy. */
  verify: Schema.Option(VerifyState),
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
  /** The local event lab. Disabled unless the host opts in through `Flags`. */
  devTools: DevToolsState,
  /** What the address bar names. The Model follows the URL, not the reverse. */
  route: ConsoleRoute,
  accounts: AccountsState,
  account: Schema.Option(AccountState),
  /** The cross-account dashboard read; loaded when the overview page opens. */
  overview: Schema.Option(OverviewState),
});
export type Model = typeof Model.Type;

/** The state of an account nothing has been read for yet. */
export const openedAccount = (id: AccountId): AccountState => ({
  id,
  billing: Option.none(),
  entitlements: Option.none(),
  events: [],
  timeline: initialTimeline,
  cursor: Option.none(),
  feed: "CatchingUp",
  error: Option.none(),
  draft: Option.none(),
  change: Option.none(),
  pending: [],
  notice: Option.none(),
  holds: Option.none(),
  providerRefs: Option.none(),
  preview: Option.none(),
  previewTier: Option.none(),
  verify: Option.none(),
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
