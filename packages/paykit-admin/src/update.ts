import type { AdminPreviewInput } from "@potion.run/paykit/Admin";
import { AdminQueries, ApplyChangeTier, ApplyRefund, next } from "@potion.run/paykit/Foldkit";
import {
  type EntitlementsState,
  type AccountEvent,
  BillingReadRow,
  AccountId,
  Standing,
  SubscriptionStatus,
  standingOf,
  appendTimeline,
  initialTimeline,
} from "@potion.run/paykit/Read";
import * as Array from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command } from "foldkit";
import { load, pushUrl, replaceUrl } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { draftFor, OperatorActions, parseDraft, updatedDraft } from "./actions.ts";
import {
  devToolsBilling,
  devToolsEntitlements,
  devToolsEventOf,
  devToolsEvents,
  devToolsHolds,
  devToolsProviderRefs,
  decodeDevToolsEvent,
  nextEventSeq,
  simulatedAt,
} from "./DevTools.ts";
import { Message } from "./Message.ts";
import {
  type AccountState,
  type ActionDraft,
  AdminFailure,
  AdminRejected,
  AdminRpcRejected,
  AdminUnknown,
  type AdminIntent,
  ChangeTierApplying,
  type ChangeTierQuote,
  ChangeTierQuoted,
  ChangeTierQuoting,
  type HoldsState,
  HoldsState as HoldsStateSchema,
  type Model,
  openedAccount,
  type OverviewState,
  OverviewState as OverviewStateSchema,
  type Pending,
  Pending as PendingSchema,
  type PreviewState,
  PreviewState as PreviewStateSchema,
  type ProviderRefsState,
  ProviderRefsState as ProviderRefsStateSchema,
  type VerifyState,
  VerifyState as VerifyStateSchema,
} from "./Model.ts";
import type { UpdateReturn } from "./Requirements.ts";
import {
  type AccountFilter,
  accountRoute,
  accountsRoute,
  afterOf,
  ConsoleRoute,
  filterOf,
  queryOf,
  reflectRoute,
  routeOf,
  sameFilter,
  samePage,
  withAfter,
  withFilter,
} from "./Route.ts";

const startList = (model: Model, filter: AccountFilter, after?: string): UpdateReturn => {
  const requestId = model.queryIds.sent;
  return {
    model: modifyFields(model, {
      queryIds: () => ({ sent: requestId + 1 }),
      accounts: (accounts) =>
        modifyFields(accounts, {
          filter: () => filter,
          state: () => "Loading",
          error: () => Option.none(),
          requestId: () => Option.some(requestId),
        }),
    }),
    commands: [
      Command.mapMessage(
        AdminQueries.ListAccounts({ requestId, query: queryOf(filter, after) }),
        (message) => Message.ReceivedAdminQuery({ message }),
      ),
    ],
  };
};

const withAccount = (model: Model, change: (account: AccountState) => AccountState): Model =>
  Option.match(model.account, {
    onNone: () => model,
    onSome: (account) => modifyFields(model, { account: () => Option.some(change(account)) }),
  });

const settle = (
  model: Model,
  commandId: string,
  status: Pending["status"],
  reason: Option.Option<string>,
  failure: Option.Option<AdminFailure> = Option.none(),
): Model =>
  withAccount(model, (account) =>
    modifyFields(account, {
      pending: () =>
        Array.map(account.pending, (pending) =>
          pending.commandId === commandId
            ? modifyFields(pending, {
                status: () => status,
                reason: () => reason,
                failure: () => failure,
              })
            : pending,
        ),
    }),
  );

const updateAccount = (
  model: Model,
  change: (account: AccountState) => AccountState,
): UpdateReturn => ({ model: withAccount(model, change) });

const accepted = (model: Model, commandId: string): Model =>
  settle(model, commandId, "Accepted", Option.none());

const isCurrentRequest = (model: Model, requestId: number): boolean =>
  Option.match(model.accounts.requestId, {
    onNone: () => false,
    onSome: (current) => current === requestId,
  });

/** The account the Model has open, without the `Option` wrapper. */
const openAccount = (model: Model): AccountState | null => Option.getOrNull(model.account);

/**
 * Read one account's holds. A hold is an entity, not a count, so it comes from
 * the aggregate rather than a view; the previous rows stay on screen and the
 * panel says it is refreshing, exactly like the list.
 */
const startHolds = (model: Model, account: AccountState): UpdateReturn => {
  const requestId = model.queryIds.sent;
  const previous = Option.getOrNull(account.holds);
  const next: HoldsState = HoldsStateSchema.make({
    requestId,
    account: account.id,
    state: "Loading",
    asOf: previous?.asOf ?? Option.none(),
    holds: previous?.holds ?? [],
    error: Option.none(),
  });
  return {
    model: modifyFields(model, {
      queryIds: () => ({ sent: requestId + 1 }),
      account: () => Option.some(modifyFields(account, { holds: () => Option.some(next) })),
    }),
    commands: [
      Command.mapMessage(AdminQueries.Holds({ requestId, account: account.id }), (message) =>
        Message.ReceivedAdminQuery({ message }),
      ),
    ],
  };
};

/** Read the vendor ids the aggregate has attached to one account. */
const startProviderRefs = (model: Model, account: AccountState): UpdateReturn => {
  const requestId = model.queryIds.sent;
  const previous = Option.getOrNull(account.providerRefs);
  const next: ProviderRefsState = ProviderRefsStateSchema.make({
    requestId,
    account: account.id,
    state: "Loading",
    asOf: previous?.asOf ?? Option.none(),
    refs: previous?.refs ?? {},
    error: Option.none(),
  });
  return {
    model: modifyFields(model, {
      queryIds: () => ({ sent: requestId + 1 }),
      account: () => Option.some(modifyFields(account, { providerRefs: () => Option.some(next) })),
    }),
    commands: [
      Command.mapMessage(AdminQueries.ProviderRefs({ requestId, account: account.id }), (message) =>
        Message.ReceivedAdminQuery({ message }),
      ),
    ],
  };
};

/** Read the cross-account dashboard: counts by dimension and recurring revenue. */
const startOverview = (model: Model): UpdateReturn => {
  const requestId = model.queryIds.sent;
  const previous = Option.getOrNull(model.overview);
  const next: OverviewState = OverviewStateSchema.make({
    requestId,
    state: "Loading",
    asOf: previous?.asOf ?? Option.none(),
    overview: previous?.overview ?? Option.none(),
    error: Option.none(),
  });
  return {
    model: modifyFields(model, {
      queryIds: () => ({ sent: requestId + 1 }),
      overview: () => Option.some(next),
    }),
    commands: [
      Command.mapMessage(AdminQueries.Overview({ requestId }), (message) =>
        Message.ReceivedAdminQuery({ message }),
      ),
    ],
  };
};

/** Ask what `decide` would do with a command, without recording anything. */
const startPreview = (
  model: Model,
  account: AccountState,
  command: AdminPreviewInput["command"],
): UpdateReturn => {
  const requestId = model.queryIds.sent;
  return {
    model: modifyFields(model, {
      queryIds: () => ({ sent: requestId + 1 }),
      account: () =>
        Option.some(
          modifyFields(account, {
            preview: () =>
              Option.some(
                PreviewStateSchema.make({
                  requestId,
                  account: account.id,
                  command,
                  state: "Loading",
                  answer: Option.none(),
                  error: Option.none(),
                }),
              ),
          }),
        ),
    }),
    commands: [
      Command.mapMessage(
        AdminQueries.Preview({ requestId, input: { account: account.id, command } }),
        (message) => Message.ReceivedAdminQuery({ message }),
      ),
    ],
  };
};

/** Judge the account's standing against the deploy's catalog and provider. */
const startVerify = (model: Model, account: AccountState): UpdateReturn => {
  const requestId = model.queryIds.sent;
  return {
    model: modifyFields(model, {
      queryIds: () => ({ sent: requestId + 1 }),
      account: () =>
        Option.some(
          modifyFields(account, {
            verify: () =>
              Option.some(
                VerifyStateSchema.make({
                  requestId,
                  account: account.id,
                  state: "Loading",
                  mismatches: [],
                  error: Option.none(),
                }),
              ),
          }),
        ),
    }),
    commands: [
      Command.mapMessage(AdminQueries.Verify({ requestId, account: account.id }), (message) =>
        Message.ReceivedAdminQuery({ message }),
      ),
    ],
  };
};

/** Combine two updates that both produce commands, keeping the first's model as the base. */
const andThen = (first: UpdateReturn, second: UpdateReturn): UpdateReturn => {
  const commands = [...(first.commands ?? []), ...(second.commands ?? [])];
  return commands.length === 0 ? { model: second.model } : { model: second.model, commands };
};

/** The events that can move a hold, so the panel re-reads them. */
const holdEvent = (tag: string): boolean =>
  tag === "UsageReserved" || tag === "UsageSettled" || tag === "UsageReleased";

/** Apply a holds answer only while its request is the one the open account waits for. */
const updateCurrentHolds = (
  model: Model,
  requestId: number,
  change: (current: HoldsState) => HoldsState,
): UpdateReturn => {
  const account = openAccount(model);
  const current = account === null ? null : Option.getOrNull(account.holds);
  if (account === null || current === null || current.requestId !== requestId) return { model };
  return updateAccount(model, (value) =>
    modifyFields(value, { holds: () => Option.some(change(current)) }),
  );
};

/** Apply a dashboard answer only while its request is the current overview. */
const updateCurrentOverview = (
  model: Model,
  requestId: number,
  change: (current: OverviewState) => OverviewState,
): UpdateReturn => {
  const current = Option.getOrNull(model.overview);
  if (current === null || current.requestId !== requestId) return { model };
  return { model: modifyFields(model, { overview: () => Option.some(change(current)) }) };
};

/** Apply a provider-refs answer only while its request is the open refs read. */
const updateCurrentProviderRefs = (
  model: Model,
  requestId: number,
  change: (current: ProviderRefsState) => ProviderRefsState,
): UpdateReturn => {
  const account = openAccount(model);
  const current = account === null ? null : Option.getOrNull(account.providerRefs);
  if (account === null || current === null || current.requestId !== requestId) return { model };
  return updateAccount(model, (value) =>
    modifyFields(value, { providerRefs: () => Option.some(change(current)) }),
  );
};

/** Apply a preview answer only while its request is the open preview. */
const updateCurrentPreview = (
  model: Model,
  requestId: number,
  change: (current: PreviewState) => PreviewState,
): UpdateReturn => {
  const account = openAccount(model);
  const current = account === null ? null : Option.getOrNull(account.preview);
  if (account === null || current === null || current.requestId !== requestId) return { model };
  return updateAccount(model, (value) =>
    modifyFields(value, { preview: () => Option.some(change(current)) }),
  );
};

/** Apply a verify answer only while its request is the open verify. */
const updateCurrentVerify = (
  model: Model,
  requestId: number,
  change: (current: VerifyState) => VerifyState,
): UpdateReturn => {
  const account = openAccount(model);
  const current = account === null ? null : Option.getOrNull(account.verify);
  if (account === null || current === null || current.requestId !== requestId) return { model };
  return updateAccount(model, (value) =>
    modifyFields(value, { verify: () => Option.some(change(current)) }),
  );
};

type CommandFailure =
  | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
  | { readonly _tag: "Denied"; readonly error: { readonly _tag: string } }
  | { readonly _tag: "Unknown" };

const failureReason = (failure: CommandFailure): string =>
  Match.value(failure).pipe(
    Match.withReturnType<string>(),
    Match.tag("Rejected", ({ rejection }) => `Rejected: ${rejection._tag}`),
    Match.tag("Denied", ({ error }) => `Denied: ${error._tag}`),
    Match.tag("Unknown", () => "Outcome unknown; retry with the same command id."),
    Match.exhaustive,
  );

type BillingAdminIntent = Exclude<AdminIntent, { readonly kind: "ChangeTier" | "Refund" }>;

/**
 * Dispatch one parsed intent to the row that declared it. Each case is a
 * one-line call because the row owns the command and its input; the switch is
 * only what narrows `intent` to the row's member.
 */
const send = (
  model: Model,
  target: AccountId,
  intent: BillingAdminIntent,
  commandId: string,
  currency?: string,
) => {
  const catalog = Option.getOrNull(model.catalog);
  const args = { target, commandId, catalog, ...(currency === undefined ? {} : { currency }) };
  switch (intent.kind) {
    case "GrantCredits":
      return OperatorActions.GrantCredits.send({ ...args, intent });
    case "ExtendTrial":
      return OperatorActions.ExtendTrial.send({ ...args, intent });
    case "EnterGrace":
      return OperatorActions.EnterGrace.send({ ...args, intent });
    case "RecordPayment":
      return OperatorActions.RecordPayment.send({ ...args, intent });
    case "RecordPaymentFailure":
      return OperatorActions.RecordPaymentFailure.send({ ...args, intent });
    case "Recover":
      return OperatorActions.Recover.send({ ...args, intent });
    case "Expire":
      return OperatorActions.Expire.send({ ...args, intent });
    case "ScheduleCancellation":
      return OperatorActions.ScheduleCancellation.send({ ...args, intent });
    case "Resume":
      return OperatorActions.Resume.send({ ...args, intent });
    case "WithdrawTierChange":
      return OperatorActions.WithdrawTierChange.send({ ...args, intent });
    case "ScheduleTierChange":
      return OperatorActions.ScheduleTierChange.send({ ...args, intent });
  }
};

const currencyOf = (account: AccountState): string | undefined =>
  Option.getOrUndefined(
    Option.flatMap(account.billing, (billing) => Option.fromNullishOr(billing.currency)),
  );

type QuotedChange = Extract<ChangeTierQuote, { readonly _tag: "Quoted" }>;

const quoteChangeTier = (model: Model, account: AccountState, tier: string): UpdateReturn => {
  const requestId = model.queryIds.sent;
  return {
    model: modifyFields(model, {
      queryIds: () => ({ sent: requestId + 1 }),
      account: () =>
        Option.some(
          modifyFields(account, {
            change: () => Option.some(ChangeTierQuoting.make({ requestId, tier })),
            notice: () => Option.none(),
          }),
        ),
    }),
    commands: [
      Command.mapMessage(
        ApplyChangeTier({ requestId, input: { account: account.id, tier } }),
        (message) => Message.ReceivedAdminChange({ message }),
      ),
    ],
  };
};

const applyChangeTier = (
  model: Model,
  account: AccountState,
  quote: QuotedChange,
): UpdateReturn => {
  const allocation = next(model.commandIds);
  const pending = PendingSchema.make({
    commandId: allocation.commandId,
    intent: { kind: "ChangeTier", tier: quote.tier },
    status: "Sending",
    reason: Option.none(),
    failure: Option.none(),
  });
  return {
    model: modifyFields(model, {
      commandIds: () => allocation.commandIds,
      account: () =>
        Option.some(
          modifyFields(account, {
            change: () =>
              Option.some(
                ChangeTierApplying.make({
                  requestId: quote.requestId,
                  tier: quote.tier,
                  proration: quote.proration,
                  commandId: allocation.commandId,
                }),
              ),
            pending: () => [pending, ...account.pending],
            notice: () => Option.none(),
          }),
        ),
    }),
    commands: [
      Command.mapMessage(
        ApplyChangeTier({
          requestId: quote.requestId,
          input: {
            account: account.id,
            tier: quote.tier,
            expected: quote.proration,
            commandId: allocation.commandId,
          },
        }),
        (message) => Message.ReceivedAdminChange({ message }),
      ),
    ],
  };
};

/** A refund names its own command id: it is the provider's idempotency key. */
const refundCommand = (
  account: AccountState,
  intent: Extract<AdminIntent, { readonly kind: "Refund" }>,
  commandId: string,
) =>
  Command.mapMessage(
    ApplyRefund({
      commandId,
      input: {
        account: account.id,
        chargeId: intent.chargeId,
        amount: intent.amount,
        currency: intent.currency,
        ...(intent.reason === undefined ? {} : { reason: intent.reason }),
      },
    }),
    (message) => Message.ReceivedAdminRefund({ message }),
  );

/**
 * A refund is a plain send, not a quote: the ceiling is the server's to check
 * against the log, and the provider's idempotency key is the command id. The
 * pending row makes a retry after an unknown outcome replay the same refund
 * instead of asking the ceiling for headroom the first attempt may have spent.
 */
const applyRefund = (
  model: Model,
  account: AccountState,
  intent: Extract<AdminIntent, { readonly kind: "Refund" }>,
): UpdateReturn => {
  const allocation = next(model.commandIds);
  const pending = PendingSchema.make({
    commandId: allocation.commandId,
    intent,
    status: "Sending",
    reason: Option.none(),
    failure: Option.none(),
  });
  return {
    model: modifyFields(model, {
      commandIds: () => allocation.commandIds,
      account: () =>
        Option.some(
          modifyFields(account, {
            draft: () => Option.none(),
            change: () => Option.none(),
            pending: () => [pending, ...account.pending],
            notice: () => Option.none(),
          }),
        ),
    }),
    commands: [refundCommand(account, intent, allocation.commandId)],
  };
};

const submit = (model: Model, account: AccountState, draft: ActionDraft): UpdateReturn => {
  const parsed = parseDraft(draft);
  if (Result.isFailure(parsed)) {
    return {
      model: modifyFields(model, {
        account: () =>
          Option.some(modifyFields(account, { notice: () => Option.some(parsed.failure) })),
      }),
    };
  }

  if (parsed.success.kind === "ChangeTier") {
    return quoteChangeTier(model, account, parsed.success.tier);
  }

  if (parsed.success.kind === "Refund") {
    return applyRefund(model, account, parsed.success);
  }

  const allocation = next(model.commandIds);
  const pending = PendingSchema.make({
    commandId: allocation.commandId,
    intent: parsed.success,
    status: "Sending",
    reason: Option.none(),
    failure: Option.none(),
  });
  return {
    model: modifyFields(model, {
      commandIds: () => allocation.commandIds,
      account: () =>
        Option.some(
          modifyFields(account, {
            draft: () => Option.none(),
            pending: () => [pending, ...account.pending],
            notice: () => Option.none(),
          }),
        ),
    }),
    commands: [send(model, account.id, parsed.success, allocation.commandId, currencyOf(account))],
  };
};

/**
 * Reflect a route into the address bar. `push` for a navigation the operator
 * chose (opening or closing an account), `replace` for a filter change, which
 * adjusts the view rather than landing somewhere new.
 */
const ReflectRoute = Command.define("ReflectRoute", {
  args: { url: Schema.String, replace: Schema.Boolean },
  messages: [Message.CompletedReflectRoute],
  execute: ({ url, replace }) =>
    (replace ? replaceUrl(url) : pushUrl(url)).pipe(Effect.as(Message.CompletedReflectRoute())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

/**
 * Make the Model follow a route. The open account is keyed by the route, so a
 * route naming another account drops the old state and its live reads restart
 * at the new account; a route that changed the filter or the page starts one
 * read for it, and opening an account reads its holds. Applying the route the
 * Model already holds is a no-op, which is what makes the runtime's echo after
 * a push harmless.
 */
const applyRoute = (model: Model, route: ConsoleRoute): UpdateReturn => {
  const filter = filterOf(route);
  const after = afterOf(route);
  const account = route._tag === "Account" ? route.account : null;
  const open = openAccount(model);
  const sameAccount = open !== null && account !== null && open.id === account;
  const followed = modifyFields(model, {
    route: () => route,
    accounts: (accounts) => modifyFields(accounts, { filter: () => filter }),
    account: () =>
      sameAccount
        ? Option.some(open)
        : account === null
          ? Option.none()
          : Option.some(openedAccount(account)),
  });
  const listChanged =
    !sameFilter(filter, model.accounts.filter) || !samePage(after, afterOf(model.route));
  const listRead = listChanged
    ? startList(followed, filter, Option.getOrUndefined(after))
    : ({ model: followed } satisfies UpdateReturn);
  const overviewRead =
    route._tag === "Overview" && model.route._tag !== "Overview" ? startOverview(followed) : null;
  const base = overviewRead === null ? listRead : andThen(listRead, overviewRead);
  // A newly opened account has no holds or refs snapshot yet; the previous
  // account's state is gone, so there is nothing to preserve.
  const opened = sameAccount ? null : openAccount(base.model);
  if (opened === null) return base;
  const holdsRead = startHolds(base.model, opened);
  const afterHolds = openAccount(holdsRead.model);
  const refsRead = afterHolds === null ? null : startProviderRefs(holdsRead.model, afterHolds);
  return andThen(base, refsRead === null ? holdsRead : andThen(holdsRead, refsRead));
};

/** Follow a route and reflect it into the address bar. */
const navigate = (model: Model, route: ConsoleRoute, history: "push" | "replace"): UpdateReturn => {
  const followed = applyRoute(model, route);
  return {
    model: followed.model,
    commands: [
      ...(followed.commands ?? []),
      ReflectRoute({ url: reflectRoute(route), replace: history === "replace" }),
    ],
  };
};

/**
 * A confirmed write can change a row — its tier, standing or credits — so the
 * list is re-read instead of left trailing the account. `ListAccounts` is a
 * point-in-time read, not a subscription; a write the console itself made is
 * the one moment it knows the snapshot is older than the account.
 */
const afterWrite = (model: Model): UpdateReturn =>
  startList(model, model.accounts.filter, Option.getOrUndefined(afterOf(model.route)));

/** Re-read the dashboard on Overview, or the list and open account elsewhere. */
const refresh = (model: Model): UpdateReturn => {
  if (model.route._tag === "Overview") return startOverview(model);
  const list = afterWrite(model);
  const account = openAccount(list.model);
  if (account === null) return list;
  const holds = startHolds(list.model, account);
  const afterHolds = openAccount(holds.model);
  const refs = afterHolds === null ? null : startProviderRefs(holds.model, afterHolds);
  return andThen(list, refs === null ? holds : andThen(holds, refs));
};

/** One event as the feed reports it, before it reaches the account. */
type IncomingEvent = {
  readonly seq: number;
  readonly at: DateTime.Utc;
  readonly commandId: string;
  readonly tag: string;
  readonly body: string;
  /**
   * The decoded event, when the feed carried one. The event lab's payload is
   * display-only, so a simulated row has no decoded event and does not enter
   * the timeline fold.
   */
  readonly event?: AccountEvent;
};

/**
 * Fold an event into the open account: dedupe by sequence, keep the last 200
 * rows, fold the decoded event into the timeline, confirm a pending command it
 * names, and re-read holds when the event moved one. The live stream and the
 * event lab share this one path.
 */
const recordEvent = (model: Model, incoming: IncomingEvent): UpdateReturn => {
  if (Option.isNone(model.account)) return { model };
  const account = model.account.value;
  if (Array.some(account.events, (candidate) => candidate.seq === incoming.seq)) {
    return { model };
  }
  const nextAccount = modifyFields(account, {
    events: () =>
      [
        {
          seq: incoming.seq,
          at: incoming.at,
          commandId: incoming.commandId,
          tag: incoming.tag,
          body: incoming.body,
        },
        ...account.events,
      ].slice(0, 200),
    timeline: () =>
      incoming.event === undefined
        ? account.timeline
        : appendTimeline(account.timeline, {
            event: incoming.event,
            envelope: { seq: incoming.seq, at: incoming.at },
          }),
    cursor: () => Option.some(incoming.seq),
  });
  const nextModel = modifyFields(model, { account: () => Option.some(nextAccount) });
  const settled = Array.some(
    account.pending,
    (candidate) => candidate.commandId === incoming.commandId,
  )
    ? accepted(nextModel, incoming.commandId)
    : nextModel;
  // A hold event is the one thing the allowance view's `reserved` count
  // cannot date, so the panel re-reads the entity it folded away. A provider
  // ref attachment is the same kind of fact for the vendor ids.
  const opened = openAccount(settled);
  if (opened === null) return { model: settled };
  if (holdEvent(incoming.tag)) return startHolds(settled, opened);
  if (incoming.tag === "ProviderRefAttached") return startProviderRefs(settled, opened);
  return { model: settled };
};

const updateDevTools = (
  model: Model,
  change: (devTools: Model["devTools"]) => Model["devTools"],
): Model => modifyFields(model, { devTools: change });

const devToolsCommandId = (model: Model): string => {
  const commandId = model.devTools.commandId.trim();
  return commandId === "" ? "devtools_command" : commandId;
};

const recordDevToolsEvent = (model: Model, event: { tag: string; body: string }): UpdateReturn => {
  const account = openAccount(model);
  if (account === null) return { model };
  const seq = nextEventSeq(account);
  const result = recordEvent(model, {
    seq,
    at: simulatedAt(seq),
    commandId: devToolsCommandId(model),
    tag: event.tag,
    body: event.body,
    ...Option.match(decodeDevToolsEvent(event), {
      onNone: () => ({}),
      onSome: (decoded) => ({ event: decoded }),
    }),
  });
  const next = updateDevTools(result.model, (devTools) => ({
    ...devTools,
    emitted: devTools.emitted + 1,
  }));
  return result.commands === undefined
    ? { model: next }
    : { model: next, commands: result.commands };
};

/**
 * Emit one lab event. With no account open the lab opens its own account
 * first, so the button is never a disabled dead end on a fresh console.
 */
const emitDevToolsEvent = (model: Model, event: { tag: string; body: string }): UpdateReturn => {
  const opened = openAccount(model) === null ? openDevToolsAccount(model) : { model };
  return andThen(opened, recordDevToolsEvent(opened.model, event));
};

/** Emit the whole table in order, one sequence number each. */
const recordAllDevToolsEvents = (model: Model): UpdateReturn => {
  const account = openAccount(model);
  if (account === null) return { model };
  const startSeq = nextEventSeq(account);
  let current = model;
  const commands: Array<NonNullable<UpdateReturn["commands"]>[number]> = [];
  for (const [index, event] of devToolsEvents.entries()) {
    const seq = startSeq + index;
    const result = recordEvent(current, {
      seq,
      at: simulatedAt(seq),
      commandId: devToolsCommandId(model),
      tag: event.tag,
      body: event.body,
      ...Option.match(decodeDevToolsEvent(event), {
        onNone: () => ({}),
        onSome: (decoded) => ({ event: decoded }),
      }),
    });
    current = result.model;
    if (result.commands !== undefined) commands.push(...result.commands);
  }
  const next = updateDevTools(current, (devTools) => ({
    ...devTools,
    emitted: devTools.emitted + devToolsEvents.length,
  }));
  return commands.length === 0 ? { model: next } : { model: next, commands };
};

/** Emit every lab event, opening the lab account first when none is open. */
const emitAllDevToolsEvents = (model: Model): UpdateReturn => {
  const opened = openAccount(model) === null ? openDevToolsAccount(model) : { model };
  return andThen(opened, recordAllDevToolsEvents(opened.model));
};

const seedTierOf = (model: Model): string =>
  Option.match(model.catalog, {
    onNone: () => model.devTools.seedTier,
    onSome: (catalog) =>
      catalog.tiers.some((tier) => String(tier.id) === model.devTools.seedTier)
        ? model.devTools.seedTier
        : (catalog.tiers[0]?.id ?? model.devTools.seedTier),
  });

const nonNegativeInt = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const withUsage = (
  entitlements: EntitlementsState,
  usage: number | undefined,
): EntitlementsState => {
  if (usage === undefined) return entitlements;
  const first = Object.entries(entitlements.features)[0];
  if (first === undefined) return entitlements;
  const [featureId, feature] = first;
  const used =
    feature.included === null || feature.included === "unlimited"
      ? usage
      : Math.min(feature.included, usage);
  const remaining =
    feature.included === null || feature.included === "unlimited"
      ? null
      : Math.max(0, feature.included - used - feature.reserved);
  return {
    ...entitlements,
    features: { ...entitlements.features, [featureId]: { ...feature, used, remaining } },
  };
};

const mergeRows = (
  rows: ReadonlyArray<BillingReadRow>,
  additions: ReadonlyArray<BillingReadRow>,
): ReadonlyArray<BillingReadRow> => {
  const byAccount = new Map(rows.map((row) => [row.account, row]));
  for (const row of additions) byAccount.set(row.account, row);
  return [...byAccount.values()].toSorted((left, right) =>
    left.account.localeCompare(right.account),
  );
};

const rowOf = (
  account: AccountId,
  tier: string,
  status: SubscriptionStatus,
  billing: ReturnType<typeof devToolsBilling>,
  entitlements: EntitlementsState,
): BillingReadRow =>
  BillingReadRow.make({
    account,
    tier,
    status,
    standing: standingOf(status),
    periodStart: billing.periodStart,
    periodEnd: billing.periodEnd,
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    credits: billing.credits,
    dunningAttempts: billing.dunningAttempts,
    ...(billing.currency === undefined ? {} : { currency: billing.currency }),
    features: entitlements.features,
  });

/** Fill the open account's reads with a simulated standing, and list it locally. */
const seedOpenSnapshot = (model: Model): UpdateReturn => {
  const account = openAccount(model);
  if (account === null) return { model };
  const at = simulatedAt(nextEventSeq(account));
  const tier = seedTierOf(model);
  const status = model.devTools.seedStatus;
  const credits = nonNegativeInt(model.devTools.seedCredits);
  const usage = nonNegativeInt(model.devTools.seedUsage);
  const holds = devToolsHolds(account.id, model.catalog, at);
  const baseBilling = devToolsBilling(account.id, model.catalog, status, at, tier);
  const billing = credits === undefined ? baseBilling : { ...baseBilling, credits };
  const baseEntitlements = devToolsEntitlements(account.id, model.catalog, status, at, holds, tier);
  const entitlements = {
    ...withUsage(baseEntitlements, usage),
    ...(credits === undefined ? {} : { credits }),
  };
  const row = rowOf(account.id, tier, status, billing, entitlements);
  const holdsState = HoldsStateSchema.make({
    requestId: Option.getOrElse(
      Option.map(account.holds, (current) => current.requestId),
      () => 0,
    ),
    account: account.id,
    state: "Loaded",
    asOf: Option.some(at),
    holds,
    error: Option.none(),
  });
  const refsState = ProviderRefsStateSchema.make({
    requestId: Option.getOrElse(
      Option.map(account.providerRefs, (current) => current.requestId),
      () => 0,
    ),
    account: account.id,
    state: "Loaded",
    asOf: Option.some(at),
    refs: devToolsProviderRefs(account.id),
    error: Option.none(),
  });
  return {
    model: modifyFields(model, {
      devTools: (devTools) => ({
        ...devTools,
        labRows: mergeRows(devTools.labRows, [row]),
      }),
      accounts: (accounts) =>
        modifyFields(accounts, { rows: () => mergeRows(accounts.rows, [row]) }),
      account: () =>
        Option.some(
          modifyFields(account, {
            billing: () => Option.some(billing),
            entitlements: () => Option.some(entitlements),
            holds: () => Option.some(holdsState),
            providerRefs: () => Option.some(refsState),
            error: () => Option.none(),
          }),
        ),
    }),
  };
};

/** Seed the configurable lab account, opening it first when none is open. */
const seedDevToolsSnapshot = (model: Model): UpdateReturn =>
  openAccount(model) === null ? openDevToolsAccount(model) : seedOpenSnapshot(model);

/** Seed a varied set of local accounts so lists, pies and metrics have a shape. */
const seedDevToolsAccounts = (model: Model): UpdateReturn => {
  if (!model.devTools.isEnabled) return { model };
  const tiers = Option.match(model.catalog, {
    onNone: () => ["free"],
    onSome: (catalog) => catalog.tiers.map((tier) => String(tier.id)),
  });
  const statuses: ReadonlyArray<SubscriptionStatus> = [
    "active",
    "trialing",
    "grace",
    "active",
    "active",
    "canceled",
    "active",
    "trialing",
    "active",
    "expired",
    "grace",
    "active",
  ];
  const at = simulatedAt(1);
  const rows = Array.makeBy(12, (index) => {
    const account = AccountId.make(`acct_demo_${String(index + 1).padStart(2, "0")}`);
    const tier = tiers[index % tiers.length] ?? "free";
    const status = statuses[index % statuses.length] ?? "active";
    const credits = 100 + index * 75;
    const usage = 50 + index * 20;
    const atForAccount = DateTime.add(at, { days: index });
    const billing = {
      ...devToolsBilling(account, model.catalog, status, atForAccount, tier),
      credits,
    };
    const entitlements = {
      ...withUsage(
        devToolsEntitlements(account, model.catalog, status, atForAccount, [], tier),
        usage,
      ),
      credits,
    };
    return rowOf(account, tier, status, billing, entitlements);
  });
  return {
    model: modifyFields(model, {
      devTools: (devTools) => ({
        ...devTools,
        labRows: mergeRows(devTools.labRows, rows),
      }),
      accounts: (accounts) =>
        modifyFields(accounts, { rows: () => mergeRows(accounts.rows, rows) }),
    }),
  };
};

/** Remove the locally seeded accounts from the list and the lab overlay. */
const clearDevToolsAccounts = (model: Model): UpdateReturn => {
  const labAccounts = new Set(model.devTools.labRows.map((row) => row.account));
  return {
    model: modifyFields(model, {
      devTools: (devTools) => ({ ...devTools, labRows: [] }),
      accounts: (accounts) =>
        modifyFields(accounts, {
          rows: () => accounts.rows.filter((row) => !labAccounts.has(row.account)),
        }),
    }),
  };
};

const newestEventSeq = (account: AccountState): number =>
  Array.reduce(account.events, 0, (max, event) => Math.max(max, event.seq));

/**
 * Open an account by id and seed it, so an empty deployment still has a page
 * to exercise. The route is the real navigation state, so the live reads
 * start exactly as they would for a clicked row.
 */
const openDevToolsAccount = (model: Model): UpdateReturn => {
  const requested = model.devTools.accountId.trim();
  const account = AccountId.make(requested === "" ? "acct_dev" : requested);
  const navigated = navigate(
    model,
    accountRoute(account, model.accounts.filter, afterOf(model.route)),
    "push",
  );
  const seeded = seedOpenSnapshot(navigated.model);
  return navigated.commands === undefined
    ? { model: seeded.model }
    : { model: seeded.model, commands: navigated.commands };
};

/** The console's update. Every write is a `BillingAdmin` command with a
 * command id; every read snapshot is applied only while its account or
 * request is open; and every navigation is a route the URL can reproduce.
 */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedRefresh: () => refresh(model),

    ClickedNextPage: () =>
      Option.match(model.accounts.next, {
        onNone: () => ({ model }),
        // The page cursor is navigation, so it goes in the URL: a refresh
        // keeps the page, and back walks it.
        onSome: (after) => navigate(model, withAfter(model.route, Option.some(after)), "push"),
      }),

    UpdatedStandingFilter: ({ value }) =>
      navigate(
        model,
        withFilter(model.route, {
          ...model.accounts.filter,
          standing: Schema.decodeUnknownOption(Standing)(value),
        }),
        "replace",
      ),

    UpdatedStatusFilter: ({ value }) =>
      navigate(
        model,
        withFilter(model.route, {
          ...model.accounts.filter,
          status: Schema.decodeUnknownOption(SubscriptionStatus)(value),
        }),
        "replace",
      ),

    UpdatedTierFilter: ({ value }) =>
      navigate(
        model,
        withFilter(model.route, {
          ...model.accounts.filter,
          tier: value === "" ? Option.none() : Option.some(value),
        }),
        "replace",
      ),

    ClickedAccount: ({ account }) =>
      // Opening an account keeps the list's filters and the page it was on, so
      // closing it (and stepping back) returns to the same list.
      navigate(model, accountRoute(account, model.accounts.filter, afterOf(model.route)), "push"),

    ClosedAccount: () =>
      navigate(model, accountsRoute(model.accounts.filter, afterOf(model.route)), "push"),

    ClickedOverview: () => navigate(model, ConsoleRoute.Overview(), "push"),

    ClickedPlans: () => navigate(model, ConsoleRoute.Plans(), "push"),

    ClickedFeatures: () => navigate(model, ConsoleRoute.Features(), "push"),

    ChangedUrl: ({ url }) => applyRoute(model, routeOf(url)),

    ClickedLink: ({ request }) =>
      Match.value(request).pipe(
        Match.withReturnType<UpdateReturn>(),
        Match.tag("Internal", ({ url }) => navigate(model, routeOf(url), "push")),
        Match.tag("External", ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        })),
        Match.exhaustive,
      ),

    CompletedReflectRoute: () => ({ model }),

    CompletedLoadExternal: () => ({ model }),

    ReceivedAdminQuery: ({ message: query }) =>
      Match.value(query).pipe(
        Match.withReturnType<UpdateReturn>(),
        Match.tag("SucceededGetCatalog", ({ catalog }) => ({
          model: modifyFields(model, {
            catalog: () => Option.some(catalog),
            catalogError: () => Option.none(),
          }),
        })),
        Match.tag("FailedGetCatalog", ({ error }) => ({
          model: modifyFields(model, { catalogError: () => Option.some(error._tag) }),
        })),
        Match.tag("SucceededListAccounts", ({ requestId, page }) =>
          isCurrentRequest(model, requestId)
            ? {
                model: modifyFields(model, {
                  accounts: (accounts) =>
                    modifyFields(accounts, {
                      rows: () => mergeRows(page.rows, model.devTools.labRows),
                      next: () => Option.fromNullishOr(page.next),
                      state: () => "Loaded",
                      error: () => Option.none(),
                      // The page says when the store answered it. A page the
                      // store did not stamp stays unstamped: the console must
                      // not invent a read time it does not have.
                      asOf: () => Option.fromNullishOr(page.asOf),
                    }),
                }),
              }
            : { model },
        ),
        Match.tag("FailedListAccounts", ({ requestId, error }) =>
          isCurrentRequest(model, requestId)
            ? {
                model: modifyFields(model, {
                  accounts: (accounts) =>
                    modifyFields(accounts, {
                      state: () => "Failed",
                      error: () => Option.some(error._tag),
                    }),
                }),
              }
            : { model },
        ),
        Match.tag("SucceededHolds", ({ requestId, answer }) =>
          updateCurrentHolds(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Loaded",
              asOf: () => Option.some(answer.asOf),
              holds: () => (answer.account === current.account ? answer.holds : current.holds),
              error: () => Option.none(),
            }),
          ),
        ),
        Match.tag("FailedHolds", ({ requestId, error }) =>
          updateCurrentHolds(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Failed",
              error: () => Option.some(error._tag),
            }),
          ),
        ),
        Match.tag("SucceededProviderRefs", ({ requestId, answer }) =>
          updateCurrentProviderRefs(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Loaded",
              asOf: () => Option.some(answer.asOf),
              refs: () => (answer.account === current.account ? answer.refs : current.refs),
              error: () => Option.none(),
            }),
          ),
        ),
        Match.tag("FailedProviderRefs", ({ requestId, error }) =>
          updateCurrentProviderRefs(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Failed",
              error: () => Option.some(error._tag),
            }),
          ),
        ),
        Match.tag("SucceededOverview", ({ requestId, overview }) =>
          updateCurrentOverview(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Loaded",
              asOf: () => Option.some(overview.asOf),
              overview: () => Option.some(overview),
              error: () => Option.none(),
            }),
          ),
        ),
        Match.tag("FailedOverview", ({ requestId, error }) =>
          updateCurrentOverview(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Failed",
              error: () => Option.some(error._tag),
            }),
          ),
        ),
        Match.tag("SucceededPreview", ({ requestId, answer }) =>
          updateCurrentPreview(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Answered",
              answer: () => Option.some(answer),
              error: () => Option.none(),
            }),
          ),
        ),
        Match.tag("FailedPreview", ({ requestId, error }) =>
          updateCurrentPreview(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Failed",
              error: () => Option.some(error._tag),
            }),
          ),
        ),
        Match.tag("SucceededVerify", ({ requestId, mismatches }) =>
          updateCurrentVerify(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Answered",
              mismatches: () => mismatches,
              error: () => Option.none(),
            }),
          ),
        ),
        Match.tag("FailedVerify", ({ requestId, error }) =>
          updateCurrentVerify(model, requestId, (current) =>
            modifyFields(current, {
              state: () => "Failed",
              error: () => Option.some(error._tag),
            }),
          ),
        ),
        Match.orElse(() => ({ model })),
      ),

    ReceivedAdminResult: ({ message: result }) =>
      Match.value(result).pipe(
        Match.withReturnType<UpdateReturn>(),
        Match.tag(
          "SucceededGrantCredits",
          "SucceededExtendTrial",
          "SucceededEnterGrace",
          "SucceededRecordPayment",
          "SucceededRecordPaymentFailure",
          "SucceededRecover",
          "SucceededExpire",
          "SucceededScheduleCancellation",
          "SucceededResume",
          ({ commandId }) => afterWrite(accepted(model, commandId)),
        ),
        Match.tag(
          "FailedGrantCredits",
          "FailedExtendTrial",
          "FailedEnterGrace",
          "FailedRecordPayment",
          "FailedRecordPaymentFailure",
          "FailedRecover",
          "FailedExpire",
          "FailedScheduleCancellation",
          "FailedResume",
          ({ commandId, failure }) => {
            const typed = Schema.decodeOption(AdminFailure)(failure);
            return {
              model: settle(
                model,
                commandId,
                failure._tag,
                Option.some(failureReason(failure)),
                Option.isSome(typed) ? Option.some(typed.value) : Option.none(),
              ),
            };
          },
        ),
        Match.orElse(() => ({ model })),
      ),

    ReceivedAdminChange: ({ message: change }) =>
      Match.value(change).pipe(
        Match.withReturnType<UpdateReturn>(),
        Match.tag("SucceededChangeTier", ({ requestId, answer }) => {
          if (Option.isNone(model.account)) return { model };
          const account = model.account.value;
          return Match.value(answer).pipe(
            Match.withReturnType<UpdateReturn>(),
            Match.tag("quoted", ({ tier, proration }) => {
              const current = account.change;
              if (
                Option.isNone(current) ||
                current.value._tag !== "Quoting" ||
                current.value.requestId !== requestId ||
                current.value.tier !== tier
              ) {
                return { model };
              }
              return updateAccount(model, (value) =>
                modifyFields(value, {
                  change: () => Option.some(ChangeTierQuoted.make({ requestId, tier, proration })),
                  notice: () => Option.none(),
                }),
              );
            }),
            Match.tag("requote", ({ tier, proration }) => {
              const commandId = Option.match(account.change, {
                onNone: () => undefined,
                onSome: (value) =>
                  value._tag === "Applying" && value.tier === tier ? value.commandId : undefined,
              });
              const next =
                commandId === undefined
                  ? model
                  : settle(
                      model,
                      commandId,
                      "Unknown",
                      Option.some("The amount moved; confirm the new quote."),
                      Option.some(AdminUnknown.make({})),
                    );
              return updateAccount(next, (value) =>
                modifyFields(value, {
                  change: () => Option.some(ChangeTierQuoted.make({ requestId, tier, proration })),
                  notice: () => Option.some("The amount moved; confirm the new quote."),
                }),
              );
            }),
            Match.tag("applied", ({ commandId, tier }) => {
              const next = settle(model, commandId, "Accepted", Option.none());
              const confirmed = updateAccount(next, (value) =>
                modifyFields(value, {
                  draft: () => Option.none(),
                  change: () => Option.none(),
                  notice: () => Option.some(`Tier changed to ${tier}.`),
                }),
              );
              return afterWrite(confirmed.model);
            }),
            Match.tag("rejected", ({ commandId, rejection }) => {
              const next =
                commandId === undefined
                  ? model
                  : settle(
                      model,
                      commandId,
                      "Rejected",
                      Option.some(rejection._tag),
                      Option.some(AdminRejected.make({ rejection })),
                    );
              return updateAccount(next, (value) =>
                modifyFields(value, {
                  draft: () => Option.none(),
                  change: () => Option.none(),
                  notice: () => Option.some(`Rejected: ${rejection._tag}`),
                }),
              );
            }),
            Match.tag("failed", ({ commandId, reason }) => {
              const next =
                commandId === undefined
                  ? model
                  : settle(
                      model,
                      commandId,
                      "Unknown",
                      Option.some(reason),
                      Option.some(AdminUnknown.make({})),
                    );
              return updateAccount(next, (value) =>
                modifyFields(value, {
                  ...(commandId === undefined ? { change: () => Option.none() } : {}),
                  notice: () => Option.some(reason),
                }),
              );
            }),
            Match.exhaustive,
          );
        }),
        Match.tag("FailedChangeTier", ({ error }) => {
          if (Option.isNone(model.account)) return { model };
          const account = model.account.value;
          const commandId = Option.match(account.change, {
            onNone: () => undefined,
            onSome: (value) => (value._tag === "Applying" ? value.commandId : undefined),
          });
          const next =
            commandId === undefined
              ? model
              : settle(
                  model,
                  commandId,
                  "Unknown",
                  Option.some(error._tag),
                  Option.some(AdminUnknown.make({})),
                );
          return updateAccount(next, (value) =>
            modifyFields(value, {
              ...(commandId === undefined ? { change: () => Option.none() } : {}),
              notice: () => Option.some(`Tier change failed: ${error._tag}`),
            }),
          );
        }),
        Match.exhaustive,
      ),

    ReceivedAdminRefund: ({ message: refund }) =>
      Match.value(refund).pipe(
        Match.withReturnType<UpdateReturn>(),
        Match.tag("SucceededRefund", ({ commandId, answer }) =>
          Match.value(answer).pipe(
            Match.withReturnType<UpdateReturn>(),
            Match.tag("applied", ({ refundId, refunded, currency }) => {
              const next = settle(model, commandId, "Accepted", Option.none());
              const confirmed = updateAccount(next, (value) =>
                modifyFields(value, {
                  draft: () => Option.none(),
                  notice: () =>
                    Option.some(`Refunded ${refundId}; ${currency} refunded so far: ${refunded}.`),
                }),
              );
              return afterWrite(confirmed.model);
            }),
            Match.tag("rejected", ({ rejection }) => {
              const next = settle(
                model,
                commandId,
                "Rejected",
                Option.some(rejection._tag),
                Option.some(AdminRpcRejected.make({ rejection })),
              );
              return updateAccount(next, (value) =>
                modifyFields(value, {
                  draft: () => Option.none(),
                  notice: () => Option.some(`Rejected: ${rejection._tag}`),
                }),
              );
            }),
            Match.tag("failed", ({ reason }) => {
              const next = settle(
                model,
                commandId,
                "Unknown",
                Option.some(reason),
                Option.some(AdminUnknown.make({})),
              );
              return updateAccount(next, (value) =>
                modifyFields(value, { notice: () => Option.some(reason) }),
              );
            }),
            Match.exhaustive,
          ),
        ),
        Match.tag("FailedRefund", ({ commandId, error }) => {
          const next = settle(
            model,
            commandId,
            "Unknown",
            Option.some(error._tag),
            Option.some(AdminUnknown.make({})),
          );
          return updateAccount(next, (value) =>
            modifyFields(value, { notice: () => Option.some(`Refund failed: ${error._tag}`) }),
          );
        }),
        Match.exhaustive,
      ),

    ReceivedBilling: ({ state }) =>
      updateAccount(model, (account) =>
        Option.isSome(state) && state.value.account !== account.id
          ? account
          : modifyFields(account, { billing: () => state }),
      ),

    ReceivedEntitlements: ({ state }) =>
      updateAccount(model, (account) => {
        if (Option.isSome(state) && state.value.account !== account.id) return account;
        return modifyFields(account, { entitlements: () => state });
      }),

    ReceivedEvent: (event) => recordEvent(model, event),

    CaughtUpEvents: ({ cursor }) =>
      updateAccount(model, (account) =>
        modifyFields(account, { cursor: () => Option.some(cursor), feed: () => "Live" }),
      ),

    FailedEvents: ({ reason }) =>
      updateAccount(model, (account) =>
        modifyFields(account, {
          feed: () => "Failed",
          error: () => Option.some(reason),
        }),
      ),

    FailedAccountWatch: ({ reason }) =>
      updateAccount(model, (account) =>
        modifyFields(account, { error: () => Option.some(reason) }),
      ),

    ClickedAction: ({ action }) =>
      updateAccount(model, (account) =>
        modifyFields(account, {
          draft: () => Option.some(draftFor(action, account.billing)),
          change: () => Option.none(),
          notice: () => Option.none(),
        }),
      ),

    UpdatedDraftField: ({ field, value }) =>
      updateAccount(model, (account) =>
        Option.match(account.draft, {
          onNone: () => account,
          onSome: (draft) =>
            modifyFields(account, { draft: () => Option.some(updatedDraft(draft, field, value)) }),
        }),
      ),

    ClickedSubmitAction: () => {
      if (Option.isNone(model.account)) return { model };
      const account = model.account.value;
      return Option.match(account.draft, {
        onNone: () => ({ model }),
        onSome: (draft) => submit(model, account, draft),
      });
    },

    ClickedConfirmChangeTier: () => {
      if (Option.isNone(model.account)) return { model };
      const account = model.account.value;
      if (Option.isNone(account.change) || Option.isNone(account.draft)) return { model };
      const change = account.change.value;
      const draft = account.draft.value;
      if (
        change._tag !== "Quoted" ||
        draft.kind !== "ChangeTier" ||
        draft.values.tier !== change.tier
      ) {
        return { model };
      }
      return applyChangeTier(model, account, change);
    },

    ClickedCancelAction: () =>
      updateAccount(model, (account) =>
        modifyFields(account, { draft: () => Option.none(), change: () => Option.none() }),
      ),

    ClickedRetryPending: ({ commandId }) => {
      if (Option.isNone(model.account)) return { model };
      const account = model.account.value;
      const pending = Array.findFirst(
        account.pending,
        (candidate) => candidate.commandId === commandId && candidate.status === "Unknown",
      );
      if (Option.isNone(pending)) return { model };

      const retried = modifyFields(model, {
        account: () =>
          Option.some(
            modifyFields(account, {
              pending: () =>
                Array.map(account.pending, (candidate) =>
                  candidate.commandId === commandId
                    ? modifyFields(candidate, {
                        status: () => "Sending",
                        reason: () => Option.none(),
                        failure: () => Option.none(),
                      })
                    : candidate,
                ),
            }),
          ),
      });

      if (pending.value.intent.kind === "ChangeTier") {
        if (Option.isNone(account.change)) return { model };
        const change = account.change.value;
        if (change._tag !== "Applying" || change.commandId !== commandId) return { model };
        return {
          model: retried,
          commands: [
            Command.mapMessage(
              ApplyChangeTier({
                requestId: change.requestId,
                input: {
                  account: account.id,
                  tier: change.tier,
                  expected: change.proration,
                  commandId,
                },
              }),
              (message) => Message.ReceivedAdminChange({ message }),
            ),
          ],
        };
      }

      if (pending.value.intent.kind === "Refund") {
        return {
          model: retried,
          commands: [refundCommand(account, pending.value.intent, commandId)],
        };
      }

      return {
        model: retried,
        commands: [send(model, account.id, pending.value.intent, commandId, currencyOf(account))],
      };
    },

    DismissedNotice: () =>
      updateAccount(model, (account) => modifyFields(account, { notice: () => Option.none() })),

    UpdatedPreviewTier: ({ value }) =>
      updateAccount(model, (account) =>
        modifyFields(account, {
          previewTier: () => (value === "" ? Option.none() : Option.some(value)),
        }),
      ),

    ClickedPreview: ({ command }) => {
      const account = openAccount(model);
      return account === null ? { model } : startPreview(model, account, command);
    },

    DismissedPreview: () =>
      updateAccount(model, (account) => modifyFields(account, { preview: () => Option.none() })),

    ClickedVerify: () => {
      const account = openAccount(model);
      return account === null ? { model } : startVerify(model, account);
    },

    DismissedVerify: () =>
      updateAccount(model, (account) => modifyFields(account, { verify: () => Option.none() })),

    ToggledDevTools: ({ isOpen }) =>
      model.devTools.isEnabled
        ? { model: updateDevTools(model, (devTools) => ({ ...devTools, isOpen })) }
        : { model },

    SelectedDevToolsTab: ({ tab }) =>
      model.devTools.isEnabled
        ? { model: updateDevTools(model, (devTools) => ({ ...devTools, tab })) }
        : { model },

    UpdatedDevToolsAccountId: ({ value }) =>
      model.devTools.isEnabled
        ? { model: updateDevTools(model, (devTools) => ({ ...devTools, accountId: value })) }
        : { model },

    ClickedOpenDevToolsAccount: () =>
      model.devTools.isEnabled ? openDevToolsAccount(model) : { model },

    UpdatedDevToolsEventTag: ({ value }) => {
      if (!model.devTools.isEnabled) return { model };
      const event = devToolsEventOf(value);
      return {
        model: updateDevTools(model, (devTools) => ({
          ...devTools,
          eventTag: value,
          ...(Option.isSome(event) ? { eventBody: event.value.body } : {}),
        })),
      };
    },

    UpdatedDevToolsEventBody: ({ value }) =>
      model.devTools.isEnabled
        ? { model: updateDevTools(model, (devTools) => ({ ...devTools, eventBody: value })) }
        : { model },

    UpdatedDevToolsCommandId: ({ value }) =>
      model.devTools.isEnabled
        ? { model: updateDevTools(model, (devTools) => ({ ...devTools, commandId: value })) }
        : { model },

    UpdatedDevToolsSeedTier: ({ value }) =>
      model.devTools.isEnabled
        ? { model: updateDevTools(model, (devTools) => ({ ...devTools, seedTier: value })) }
        : { model },

    UpdatedDevToolsSeedStatus: ({ value }) => {
      if (!model.devTools.isEnabled) return { model };
      const status = Schema.decodeUnknownOption(SubscriptionStatus)(value);
      return Option.isNone(status)
        ? { model }
        : {
            model: updateDevTools(model, (devTools) => ({
              ...devTools,
              seedStatus: status.value,
            })),
          };
    },

    UpdatedDevToolsSeedCredits: ({ value }) =>
      model.devTools.isEnabled
        ? { model: updateDevTools(model, (devTools) => ({ ...devTools, seedCredits: value })) }
        : { model },

    UpdatedDevToolsSeedUsage: ({ value }) =>
      model.devTools.isEnabled
        ? { model: updateDevTools(model, (devTools) => ({ ...devTools, seedUsage: value })) }
        : { model },

    ClickedEmitDevToolsEvent: () => {
      if (!model.devTools.isEnabled) return { model };
      const event = devToolsEventOf(model.devTools.eventTag);
      return Option.isNone(event) ? { model } : emitDevToolsEvent(model, event.value);
    },

    ClickedEmitAllDevToolsEvents: () =>
      model.devTools.isEnabled ? emitAllDevToolsEvents(model) : { model },

    ClickedSeedDevToolsSnapshot: () =>
      model.devTools.isEnabled ? seedDevToolsSnapshot(model) : { model },

    ClickedSeedDevToolsAccounts: () =>
      model.devTools.isEnabled ? seedDevToolsAccounts(model) : { model },

    ClickedClearDevToolsAccounts: () =>
      model.devTools.isEnabled ? clearDevToolsAccounts(model) : { model },

    ClickedCatchUpDevToolsFeed: () => {
      if (!model.devTools.isEnabled) return { model };
      return updateAccount(model, (account) =>
        modifyFields(account, {
          feed: () => "Live",
          cursor: () =>
            Option.some(
              Math.max(
                Option.getOrElse(account.cursor, () => 0),
                newestEventSeq(account),
              ),
            ),
        }),
      );
    },

    ClickedFailDevToolsFeed: () =>
      model.devTools.isEnabled
        ? updateAccount(model, (account) =>
            modifyFields(account, {
              feed: () => "Failed",
              error: () => Option.some("Simulated feed failure."),
            }),
          )
        : { model },

    ClickedFailDevToolsReads: () =>
      model.devTools.isEnabled
        ? updateAccount(model, (account) =>
            modifyFields(account, { error: () => Option.some("Simulated read failure.") }),
          )
        : { model },

    ClickedResetDevTools: () => {
      if (!model.devTools.isEnabled) return { model };
      const cleared = clearDevToolsAccounts(model);
      const reset = updateDevTools(cleared.model, (devTools) => ({ ...devTools, emitted: 0 }));
      return updateAccount(reset, (account) =>
        modifyFields(account, {
          events: () => [],
          timeline: () => initialTimeline,
          cursor: () => Option.none(),
          feed: () => "CatchingUp",
          error: () => Option.none(),
          draft: () => Option.none(),
          change: () => Option.none(),
          pending: () => [],
          notice: () => Option.none(),
          holds: () => Option.none(),
          providerRefs: () => Option.none(),
          preview: () => Option.none(),
          verify: () => Option.none(),
        }),
      );
    },
  });
