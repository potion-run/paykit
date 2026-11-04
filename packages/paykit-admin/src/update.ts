import type { BillingReadQuery } from "@potion.run/paykit/BillingReadStore";
import { AdminQueries, ApplyChangeTier, BillingAdmin, next } from "@potion.run/paykit/Foldkit";
import {
  AccountId,
  Standing,
  SubscriptionStatus,
} from "@potion.run/paykit/Subscription/Subscription.state";
import * as Array from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { Message } from "./Message.ts";
import {
  type AccountFilter,
  type AccountState,
  type ActionDraft,
  AccountState as AccountStateSchema,
  type AdminIntent,
  ChangeTierApplying,
  type ChangeTierQuote,
  ChangeTierQuoted,
  ChangeTierQuoting,
  type Model,
  type Pending,
  Pending as PendingSchema,
} from "./Model.ts";
import type { UpdateReturn } from "./Requirements.ts";

const queryOf = (filter: AccountFilter, after?: string): BillingReadQuery => ({
  ...(Option.isSome(filter.standing) ? { standing: filter.standing.value } : {}),
  ...(Option.isSome(filter.status) ? { status: filter.status.value } : {}),
  ...(Option.isSome(filter.tier) ? { tier: filter.tier.value } : {}),
  ...(after === undefined ? {} : { after }),
});

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
): Model =>
  withAccount(model, (account) =>
    modifyFields(account, {
      pending: () =>
        Array.map(account.pending, (pending) =>
          pending.commandId === commandId
            ? modifyFields(pending, { status: () => status, reason: () => reason })
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

const positiveInt = (value: string): Result.Result<number, string> => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Result.succeed(parsed)
    : Result.fail("Enter a positive whole amount in minor units.");
};

const nonEmpty = (value: string, label: string): Result.Result<string, string> =>
  value.trim() === "" ? Result.fail(`Enter a ${label}.`) : Result.succeed(value.trim());

const dateTime = (value: string, label: string): Result.Result<DateTime.Utc, string> => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? Result.fail(`Enter a valid ${label}.`)
    : Result.succeed(DateTime.fromDateUnsafe(parsed));
};

const parseDraft = (draft: ActionDraft): Result.Result<AdminIntent, string> => {
  switch (draft.kind) {
    case "GrantCredits":
      return Result.map(positiveInt(draft.amount), (amount) => ({ kind: "GrantCredits", amount }));
    case "ExtendTrial":
      return Result.map(dateTime(draft.trialEndsAt, "trial end"), (trialEndsAt) => ({
        kind: "ExtendTrial",
        trialEndsAt,
      }));
    case "EnterGrace":
      return Result.map(dateTime(draft.graceUntil, "grace deadline"), (graceUntil) => ({
        kind: "EnterGrace",
        graceUntil,
      }));
    case "RecordPayment":
      return Result.flatMap(positiveInt(draft.amount), (amount) =>
        Result.map(nonEmpty(draft.currency, "currency"), (currency) => ({
          kind: "RecordPayment",
          amount,
          currency,
        })),
      );
    case "RecordPaymentFailure":
      return Result.flatMap(nonEmpty(draft.reason, "reason"), (reason) =>
        Result.map(dateTime(draft.graceUntil, "grace deadline"), (graceUntil) => ({
          kind: "RecordPaymentFailure",
          reason,
          graceUntil,
        })),
      );
    case "Recover":
    case "Expire":
    case "ScheduleCancellation":
    case "Resume":
      return Result.succeed({ kind: draft.kind });
    case "ChangeTier":
      return Result.map(nonEmpty(draft.tier, "tier"), (tier) => ({ kind: "ChangeTier", tier }));
  }
};

const draftFor = (kind: ActionDraft["kind"], billing: AccountState["billing"]): ActionDraft => {
  const currency = Option.match(billing, {
    onNone: () => "usd",
    onSome: (state) => state.currency ?? "usd",
  });
  switch (kind) {
    case "GrantCredits":
      return { kind, amount: "" };
    case "ExtendTrial":
      return { kind, trialEndsAt: "" };
    case "EnterGrace":
      return { kind, graceUntil: "" };
    case "RecordPayment":
      return { kind, amount: "", currency };
    case "RecordPaymentFailure":
      return { kind, reason: "", graceUntil: "" };
    case "Recover":
    case "Expire":
    case "ScheduleCancellation":
    case "Resume":
      return { kind };
    case "ChangeTier":
      return { kind, tier: "" };
  }
};

const updatedDraft = (draft: ActionDraft, field: string, value: string): ActionDraft => {
  switch (draft.kind) {
    case "GrantCredits":
      return field === "amount" ? { kind: "GrantCredits", amount: value } : draft;
    case "ExtendTrial":
      return field === "trialEndsAt" ? { kind: "ExtendTrial", trialEndsAt: value } : draft;
    case "EnterGrace":
      return field === "graceUntil" ? { kind: "EnterGrace", graceUntil: value } : draft;
    case "RecordPayment":
      if (field === "amount")
        return { kind: "RecordPayment", amount: value, currency: draft.currency };
      if (field === "currency")
        return { kind: "RecordPayment", amount: draft.amount, currency: value };
      return draft;
    case "RecordPaymentFailure":
      if (field === "reason")
        return { kind: "RecordPaymentFailure", reason: value, graceUntil: draft.graceUntil };
      if (field === "graceUntil")
        return { kind: "RecordPaymentFailure", reason: draft.reason, graceUntil: value };
      return draft;
    case "Recover":
    case "Expire":
    case "ScheduleCancellation":
    case "Resume":
      return draft;
    case "ChangeTier":
      return field === "tier" ? { kind: "ChangeTier", tier: value } : draft;
  }
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

type BillingAdminIntent = Exclude<AdminIntent, { readonly kind: "ChangeTier" }>;

const send = (target: AccountId, intent: BillingAdminIntent, commandId: string) => {
  const wrap = (message: typeof BillingAdmin.Message.Type) =>
    Message.ReceivedAdminResult({ message });
  switch (intent.kind) {
    case "GrantCredits":
      return Command.mapMessage(
        BillingAdmin.GrantCredits({ target, input: { amount: intent.amount }, commandId }),
        wrap,
      );
    case "ExtendTrial":
      return Command.mapMessage(
        BillingAdmin.ExtendTrial({
          target,
          input: { trialEndsAt: intent.trialEndsAt },
          commandId,
        }),
        wrap,
      );
    case "EnterGrace":
      return Command.mapMessage(
        BillingAdmin.EnterGrace({ target, input: { graceUntil: intent.graceUntil }, commandId }),
        wrap,
      );
    case "RecordPayment":
      return Command.mapMessage(
        BillingAdmin.RecordPayment({
          target,
          input: { amount: intent.amount, currency: intent.currency },
          commandId,
        }),
        wrap,
      );
    case "RecordPaymentFailure":
      return Command.mapMessage(
        BillingAdmin.RecordPaymentFailure({
          target,
          input: { reason: intent.reason, graceUntil: intent.graceUntil },
          commandId,
        }),
        wrap,
      );
    case "Recover":
      return Command.mapMessage(BillingAdmin.Recover({ target, input: {}, commandId }), wrap);
    case "Expire":
      return Command.mapMessage(BillingAdmin.Expire({ target, input: {}, commandId }), wrap);
    case "ScheduleCancellation":
      return Command.mapMessage(
        BillingAdmin.ScheduleCancellation({ target, input: {}, commandId }),
        wrap,
      );
    case "Resume":
      return Command.mapMessage(BillingAdmin.Resume({ target, input: {}, commandId }), wrap);
  }
};

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

  const allocation = next(model.commandIds);
  const pending = PendingSchema.make({
    commandId: allocation.commandId,
    intent: parsed.success,
    status: "Sending",
    reason: Option.none(),
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
    commands: [send(account.id, parsed.success, allocation.commandId)],
  };
};

/**
 * The console's update. Every write is a `BillingAdmin` command with a
 * command id; every read snapshot is applied only while its account is open.
 */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedRefresh: () => startList(model, model.accounts.filter),

    ClickedNextPage: () =>
      Option.match(model.accounts.next, {
        onNone: () => ({ model }),
        onSome: (after) => startList(model, model.accounts.filter, after),
      }),

    UpdatedStandingFilter: ({ value }) =>
      startList(model, {
        ...model.accounts.filter,
        standing: Schema.decodeUnknownOption(Standing)(value),
      }),

    UpdatedStatusFilter: ({ value }) =>
      startList(model, {
        ...model.accounts.filter,
        status: Schema.decodeUnknownOption(SubscriptionStatus)(value),
      }),

    UpdatedTierFilter: ({ value }) =>
      startList(model, {
        ...model.accounts.filter,
        tier: value === "" ? Option.none() : Option.some(value),
      }),

    ClickedAccount: ({ account }) => ({
      model: modifyFields(model, {
        account: () =>
          Option.some(
            AccountStateSchema.make({
              id: account,
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
            }),
          ),
      }),
    }),

    ClosedAccount: () => ({
      model: modifyFields(model, { account: () => Option.none() }),
    }),

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
                      rows: () => page.rows,
                      next: () => Option.fromNullishOr(page.next),
                      state: () => "Loaded",
                      error: () => Option.none(),
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
          ({ commandId }) => ({ model: accepted(model, commandId) }),
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
          ({ commandId, failure }) => ({
            model: settle(model, commandId, failure._tag, Option.some(failureReason(failure))),
          }),
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
              return updateAccount(next, (value) =>
                modifyFields(value, {
                  draft: () => Option.none(),
                  change: () => Option.none(),
                  notice: () => Option.some(`Tier changed to ${tier}.`),
                }),
              );
            }),
            Match.tag("rejected", ({ commandId, rejection }) => {
              const next =
                commandId === undefined
                  ? model
                  : settle(model, commandId, "Rejected", Option.some(rejection._tag));
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
                  : settle(model, commandId, "Unknown", Option.some(reason));
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
              : settle(model, commandId, "Unknown", Option.some(error._tag));
          return updateAccount(next, (value) =>
            modifyFields(value, {
              ...(commandId === undefined ? { change: () => Option.none() } : {}),
              notice: () => Option.some(`Tier change failed: ${error._tag}`),
            }),
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

    ReceivedEvent: ({ seq, at, commandId, tag, body }) => {
      if (Option.isNone(model.account)) return { model };
      const account = model.account.value;
      if (Array.some(account.events, (event) => event.seq === seq)) return { model };
      const nextAccount = modifyFields(account, {
        events: () => [{ seq, at, commandId, tag, body }, ...account.events].slice(0, 200),
        cursor: () => Option.some(seq),
      });
      const nextModel = modifyFields(model, { account: () => Option.some(nextAccount) });
      return {
        model: Array.some(account.pending, (candidate) => candidate.commandId === commandId)
          ? accepted(nextModel, commandId)
          : nextModel,
      };
    },

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
      if (change._tag !== "Quoted" || draft.kind !== "ChangeTier" || draft.tier !== change.tier) {
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

      return {
        model: retried,
        commands: [send(account.id, pending.value.intent, commandId)],
      };
    },

    DismissedNotice: () =>
      updateAccount(model, (account) => modifyFields(account, { notice: () => Option.none() })),
  });
