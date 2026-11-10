import { describe, expect, it } from "@alchemy.run/test";
import {
  AccountId,
  BillingAdminApi,
  BillingReadPage,
  Catalog,
  CreditsGranted,
  NotSubscribed,
  RefundExceedsCharged,
  SubscriptionActivated,
  UsageRecorded,
  UsageReserved,
  planItem,
  catalog,
  messages,
  plan,
} from "@potion.run/paykit";
import {
  AdminReadFailed,
  ChangeTierApplied,
  ChangeTierQuoted,
  HoldsAnswer,
  PreviewAccepted,
  PreviewRejected,
  PreviewUnpredictable,
  RefundApplied,
  RefundRejected,
} from "@potion.run/paykit/Admin";
import {
  AdminChangeCommands,
  AdminQueries,
  AdminRefundCommands,
  BillingAdmin,
} from "@potion.run/paykit/Foldkit";
import type { BillingStateView } from "@potion.run/paykit/Read";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Url } from "foldkit/url";
import { Flags } from "../src/Flags.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/Message.ts";
import { ConsoleAction, Model } from "../src/Model.ts";
import { ConsoleRoute } from "../src/Route.ts";
import { AccountSnapshot } from "../src/Snapshot.ts";
import { update } from "../src/update.ts";

const free = plan({ id: "free", grants: [planItem(messages, { included: 100 })] });

const pro = plan({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [planItem(messages, { included: 2_000 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [free, pro] }));
const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const account = AccountId.make("acct_a");

const row = {
  account: account,
  tier: "pro",
  status: "active" as const,
  standing: "good" as const,
  periodStart: at,
  periodEnd: at,
  cancelAtPeriodEnd: false,
  credits: 0,
  prepaidCredits: 0,
  dunningAttempts: 0,
  currency: "usd",
  features: {},
};

const page = BillingReadPage.make({ rows: [row], next: null });

/** A URL the runtime would hand `init`; `search` has no leading `?`. */
const url = (pathname = "/", search?: string): Url => ({
  protocol: "https:",
  host: "admin.test",
  port: Option.none(),
  pathname,
  search: Option.fromNullishOr(search),
  hash: Option.none(),
});

const flags = (overrides: Partial<Flags> = {}): Flags =>
  Flags.make({
    session: "session-1",
    ...overrides,
  });

const seeded = (): Model =>
  init(
    flags({
      catalog: Schema.encodeSync(Catalog)(testCatalog),
      accounts: Schema.encodeSync(BillingReadPage)(page),
    }),
    url(),
  ).model;

const opened = (): Model => {
  const model = seeded();

  return update(model, Message.ClickedAccount({ account })).model;
};

const billing: BillingStateView = {
  account: account,
  tier: "pro",
  plans: {
    pro: {
      planId: "pro",
      version: 1,
      group: "default",
      addOn: false,
      allowances: {},
      credits: 0,
      creditsExpire: "period",
      rates: {},
      interval: "month",
      currency: "usd",
      price: { amount: 1900, currency: "usd", interval: "month" },
    },
  },
  schedule: [],
  entities: [],
  status: "active" as const,
  periodStart: at,
  periodEnd: at,
  interval: "month" as const,
  anchorTz: "UTC",
  cancelAtPeriodEnd: false,
  credits: 0,
  dunningAttempts: 0,
  currency: "usd",
  price: { amount: 1900, currency: "usd", interval: "month" as const },
};

const entitlementsState = {
  account: account,
  tier: "pro",
  status: "active" as const,
  standing: "good" as const,
  periodStart: at,
  periodEnd: at,
  cancelAtPeriodEnd: false,
  credits: 0,
  prepaidCredits: 0,
  dunningAttempts: 0,
  currency: "usd",
  features: {
    messages: {
      included: 2_000,
      used: 0,
      reserved: 0,
      remaining: 2_000,
      carried: 0,
      allowed: true,
      overage: "bill" as const,
      resets: "month" as const,
      resetsAt: at,
    },
  },
};

const withBilling = (overrides: Partial<typeof billing> = {}): Model =>
  update(opened(), Message.ReceivedBilling({ state: Option.some({ ...billing, ...overrides }) }))
    .model;

const withDraft = (amount: string): Model => {
  const model = withBilling();
  const openedDraft = update(model, Message.ClickedAction({ action: "GrantCredits" })).model;

  return update(openedDraft, Message.UpdatedDraftField({ field: "amount", value: amount })).model;
};

/**
 * A reversal draft opened the way the refunds panel opens it: the row carries
 * the refund and the amount still outstanding, so nothing is typed twice.
 */
const withReverseDraft = (refunds: BillingStateView["refunds"]): Model => {
  const model = withBilling({ refunds });
  const row = Object.values(refunds ?? {})[0];

  if (row === undefined) return model;

  return update(
    model,
    Message.ClickedReverseRefund({
      refundId: row.refundId,
      outstanding: row.amount - (row.reversed ?? 0),
    }),
  ).model;
};

const withChangeDraft = (tier: string): Model => {
  const model = withBilling();
  const openedDraft = update(model, Message.ClickedAction({ action: "ChangeTier" })).model;

  return update(openedDraft, Message.UpdatedDraftField({ field: "tier", value: tier })).model;
};

const withScheduleDraft = (tier: string): Model => {
  const model = withBilling();
  const openedDraft = update(model, Message.ClickedAction({ action: "ScheduleTierChange" })).model;

  return update(openedDraft, Message.UpdatedDraftField({ field: "tier", value: tier })).model;
};

/** A refund draft over a standing that was charged more than it gave back. */
const withRefundDraft = (amount: string): Model => {
  const model = withBilling({ charged: { usd: 4_900 }, refunded: { usd: 900 } });
  const openedDraft = update(model, Message.ClickedAction({ action: "Refund" })).model;

  return update(
    update(openedDraft, Message.UpdatedDraftField({ field: "chargeId", value: "ch_1" })).model,
    Message.UpdatedDraftField({ field: "amount", value: amount }),
  ).model;
};

describe("the console model", () => {
  it("seeds the first paint from flags without asking again", () => {
    const result = init(
      flags({
        catalog: Schema.encodeSync(Catalog)(testCatalog),
        accounts: Schema.encodeSync(BillingReadPage)(page),
      }),
      url(),
    );

    expect(result.commands).toBeUndefined();
    expect(Option.isSome(result.model.catalog)).toBe(true);
    expect(result.model.accounts.rows.length).toBe(1);
    expect(result.model.accounts.state).toBe("Loaded");
  });

  it("asks for the catalog and the first page when flags do not seed them", () => {
    const result = init(flags(), url());
    expect(result.commands?.map((command) => command.name)).toEqual(["GetCatalog", "ListAccounts"]);
    expect(result.model.accounts.state).toBe("Loading");
  });

  it("applies a list page only for the request it answers", () => {
    const model = init(flags(), url()).model;
    const requestId = Option.getOrThrow(model.accounts.requestId);

    const accepted = update(
      model,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededListAccounts({ requestId, page }),
      }),
    ).model;

    expect(accepted.accounts.rows.length).toBe(1);

    const stale = update(
      accepted,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededListAccounts({
          requestId: requestId + 1,
          page: BillingReadPage.make({ rows: [], next: null }),
        }),
      }),
    ).model;

    expect(stale.accounts.rows.length).toBe(1);
  });

  it("opens an account and applies its billing snapshot", () => {
    const model = withBilling();
    expect(Option.isSome(model.account)).toBe(true);

    if (Option.isNone(model.account)) return;
    expect(model.account.value.id).toBe(account);
    expect(Option.isSome(model.account.value.billing)).toBe(true);
  });

  it("turns a submitted intent into one command with one pending id", () => {
    const model = withDraft("250");
    const result = update(model, Message.ClickedSubmitAction());
    expect(result.commands?.map((command) => command.name)).toEqual(["GrantCredits"]);

    if (Option.isNone(result.model.account)) return;
    expect(result.model.account.value.pending.length).toBe(1);
    expect(result.model.account.value.pending[0]?.status).toBe("Sending");
    expect(result.model.commandIds.sent).toBe(1);
  });

  it("refuses an invalid amount without sending or clearing the draft", () => {
    const model = withDraft("0");
    const result = update(model, Message.ClickedSubmitAction());
    expect(result.commands).toBeUndefined();

    if (Option.isNone(result.model.account)) return;
    expect(Option.isSome(result.model.account.value.notice)).toBe(true);
    expect(Option.isSome(result.model.account.value.draft)).toBe(true);
    expect(result.model.account.value.pending).toEqual([]);
  });

  it("keeps the typed rejection as evidence when a command is refused", () => {
    const submitted = update(withDraft("250"), Message.ClickedSubmitAction());

    if (Option.isNone(submitted.model.account)) return;
    const pending = submitted.model.account.value.pending[0];

    if (pending === undefined) return;

    const refused = update(
      submitted.model,
      Message.ReceivedAdminResult({
        message: BillingAdmin.Message.FailedGrantCredits({
          commandId: pending.commandId,
          failure: {
            _tag: "Rejected",
            rejection: new NotSubscribed({ account }),
          },
        }),
      }),
    ).model;

    if (Option.isNone(refused.account)) return;
    const settled = refused.account.value.pending[0];
    expect(settled?.status).toBe("Rejected");
    expect(Option.isSome(settled?.failure ?? Option.none())).toBe(true);

    if (settled !== undefined && Option.isSome(settled.failure)) {
      expect(settled.failure.value._tag).toBe("Rejected");

      if (settled.failure.value._tag === "Rejected") {
        expect(settled.failure.value.rejection._tag).toBe("NotSubscribed");
      }
    }
  });

  it("settles a pending command from the Api reply", () => {
    const model = withDraft("250");
    const submitted = update(model, Message.ClickedSubmitAction());

    const commandId = submitted.model.account.pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.pending[0]?.commandId)),
      Option.getOrThrow,
    );

    const settled = update(
      submitted.model,
      Message.ReceivedAdminResult({
        message: BillingAdmin.Message.SucceededGrantCredits({
          commandId,
          reply: { balance: 250 },
          receipt: { stream: "Subscription/acct_a", version: 2 },
        }),
      }),
    ).model;

    expect(
      settled.account.pipe(
        Option.flatMap((value) => Option.fromNullishOr(value.pending[0])),
        Option.map((pending) => pending.status),
        Option.getOrThrow,
      ),
    ).toBe("Accepted");
  });

  it("confirms a pending command from the event feed and records the event", () => {
    const model = withDraft("250");
    const submitted = update(model, Message.ClickedSubmitAction());

    const commandId = submitted.model.account.pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.pending[0]?.commandId)),
      Option.getOrThrow,
    );

    const received = update(
      submitted.model,
      Message.ReceivedEvent({
        seq: 1,
        at,
        commandId,
        tag: "CreditsGranted",
        body: "{}",
        event: new CreditsGranted({ amount: 250, balanceAfter: 250 }),
      }),
    ).model;

    if (Option.isNone(received.account)) return;
    expect(received.account.value.events[0]?.tag).toBe("CreditsGranted");
    expect(received.account.value.cursor).toEqual(Option.some(1));
    expect(received.account.value.pending[0]?.status).toBe("Accepted");
  });

  it("retries an unknown outcome with the same command id", () => {
    const model = withDraft("250");
    const submitted = update(model, Message.ClickedSubmitAction());

    const commandId = submitted.model.account.pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.pending[0]?.commandId)),
      Option.getOrThrow,
    );

    const unknown = update(
      submitted.model,
      Message.ReceivedAdminResult({
        message: BillingAdmin.Message.FailedGrantCredits({
          commandId,
          failure: { _tag: "Unknown" },
        }),
      }),
    ).model;

    const retried = update(unknown, Message.ClickedRetryPending({ commandId }));
    expect(retried.commands?.map((command) => command.name)).toEqual(["GrantCredits"]);
    expect(retried.commands?.[0]?.args?.commandId).toBe(commandId);
    expect(
      retried.model.account.pipe(
        Option.flatMap((value) => Option.fromNullishOr(value.pending[0])),
        Option.map((pending) => pending.status),
        Option.getOrThrow,
      ),
    ).toBe("Sending");
  });

  it("sends a refund through the console RPC with one pending id", () => {
    const result = update(withRefundDraft("1000"), Message.ClickedSubmitAction());
    expect(result.commands?.map((command) => command.name)).toEqual(["ApplyRefund"]);

    if (Option.isNone(result.model.account)) return;
    const pending = result.model.account.value.pending[0];
    expect(pending?.intent.kind).toBe("Refund");
    expect(result.commands?.[0]?.args?.commandId).toBe(pending?.commandId);
    expect(Option.isNone(result.model.account.value.draft)).toBe(true);
  });

  it("keeps a refused refund typed as evidence", () => {
    const submitted = update(withRefundDraft("1000"), Message.ClickedSubmitAction());

    if (Option.isNone(submitted.model.account)) return;
    const pending = submitted.model.account.value.pending[0];

    if (pending === undefined) return;

    const refused = update(
      submitted.model,
      Message.ReceivedAdminRefund({
        message: AdminRefundCommands.Message.SucceededRefund({
          commandId: pending.commandId,
          answer: RefundRejected.make({
            commandId: pending.commandId,
            rejection: new RefundExceedsCharged({
              currency: "usd",
              charged: 4_900,
              refunded: 4_000,
              requested: 1_000,
            }),
          }),
        }),
      }),
    ).model;

    if (Option.isNone(refused.account)) return;
    const settled = refused.account.value.pending[0];
    expect(settled?.status).toBe("Rejected");

    if (settled !== undefined && Option.isSome(settled.failure)) {
      expect(settled.failure.value._tag).toBe("RpcRejected");

      if (settled.failure.value._tag === "RpcRejected") {
        expect(settled.failure.value.rejection._tag).toBe("RefundExceedsCharged");
      }
    }
  });

  it("settles an applied refund and re-reads the list", () => {
    const submitted = update(withRefundDraft("1000"), Message.ClickedSubmitAction());

    if (Option.isNone(submitted.model.account)) return;
    const pending = submitted.model.account.value.pending[0];

    if (pending === undefined) return;

    const applied = update(
      submitted.model,
      Message.ReceivedAdminRefund({
        message: AdminRefundCommands.Message.SucceededRefund({
          commandId: pending.commandId,
          answer: RefundApplied.make({
            commandId: pending.commandId,
            refundId: "re_1",
            refunded: 1_900,
            currency: "usd",
          }),
        }),
      }),
    );

    expect(applied.commands?.map((command) => command.name)).toEqual(["ListAccounts"]);

    if (Option.isNone(applied.model.account)) return;
    expect(applied.model.account.value.pending[0]?.status).toBe("Accepted");
    expect(
      Option.match(applied.model.account.value.notice, {
        onNone: () => "",
        onSome: (notice) => notice,
      }),
    ).toContain("re_1");
  });

  it("retries a refund with the same command id after an unknown outcome", () => {
    const submitted = update(withRefundDraft("1000"), Message.ClickedSubmitAction());

    if (Option.isNone(submitted.model.account)) return;
    const pending = submitted.model.account.value.pending[0];

    if (pending === undefined) return;

    const unknown = update(
      submitted.model,
      Message.ReceivedAdminRefund({
        message: AdminRefundCommands.Message.FailedRefund({
          commandId: pending.commandId,
          error: new AdminReadFailed({ reason: "offline", message: "offline" }),
        }),
      }),
    ).model;

    if (Option.isNone(unknown.account)) return;
    expect(unknown.account.value.pending[0]?.status).toBe("Unknown");

    const retried = update(unknown, Message.ClickedRetryPending({ commandId: pending.commandId }));
    expect(retried.commands?.map((command) => command.name)).toEqual(["ApplyRefund"]);
    expect(retried.commands?.[0]?.args?.commandId).toBe(pending.commandId);
  });

  it("opens a reversal from a refund row and sends it with the row's numbers", () => {
    const model = withReverseDraft({
      re_1: { refundId: "re_1", amount: 4_900, currency: "usd" },
    });

    if (Option.isNone(model.account)) return;
    const draft = model.account.value.draft;

    if (Option.isNone(draft)) return;
    expect(draft.value.kind).toBe("ReverseRefund");
    expect(draft.value.values).toEqual({ refundId: "re_1", amount: "4900", reason: "" });

    const result = update(model, Message.ClickedSubmitAction());
    expect(result.commands?.map((command) => command.name)).toEqual(["ReverseRefund"]);

    if (Option.isNone(result.model.account)) return;
    expect(result.model.account.value.pending.length).toBe(1);
  });

  it("covers every admin Api command", () => {
    // Refund is not on the Api: it runs on the console's RPC because the Api
    // layer cannot reach the provider. It is covered by the console's stories.
    const covered = ConsoleAction.filter((action) => action !== "Refund").sort();
    const served = BillingAdminApi.commands.map((command) => command.tag).sort();
    expect(covered).toEqual(served);
  });

  it("quotes a plan change, then applies only the confirmed amount", () => {
    const quotedRequest = update(withChangeDraft("free"), Message.ClickedSubmitAction());
    expect(quotedRequest.commands?.map((command) => command.name)).toEqual(["ApplyChangeTier"]);

    if (Option.isNone(quotedRequest.model.account)) return;
    const quoting = quotedRequest.model.account.value.change;
    expect(Option.isSome(quoting)).toBe(true);

    if (Option.isNone(quoting)) return;
    expect(quoting.value._tag).toBe("Quoting");

    if (quoting.value._tag !== "Quoting") return;
    const requestId = quoting.value.requestId;

    const quoted = update(
      quotedRequest.model,
      Message.ReceivedAdminChange({
        message: AdminChangeCommands.Message.SucceededChangeTier({
          requestId,
          answer: ChangeTierQuoted.make({
            tier: "free",
            proration: { currency: "usd", credit: 1900, charge: 0, due: -1900 },
          }),
        }),
      }),
    ).model;

    if (Option.isNone(quoted.account)) return;
    expect(Option.isSome(quoted.account.value.change)).toBe(true);

    if (Option.isSome(quoted.account.value.change)) {
      expect(quoted.account.value.change.value._tag).toBe("Quoted");
    }

    const confirmed = update(quoted, Message.ClickedConfirmChangeTier());
    expect(confirmed.commands?.map((command) => command.name)).toEqual(["ApplyChangeTier"]);

    if (Option.isNone(confirmed.model.account)) return;
    const pending = confirmed.model.account.value.pending[0];
    expect(pending?.status).toBe("Sending");

    if (pending === undefined) return;

    const applied = update(
      confirmed.model,
      Message.ReceivedAdminChange({
        message: AdminChangeCommands.Message.SucceededChangeTier({
          requestId,
          answer: ChangeTierApplied.make({
            commandId: pending.commandId,
            tier: "free",
            proration: { currency: "usd", credit: 1900, charge: 0, due: -1900 },
            stream: "Subscription/acct_a",
            version: 2,
          }),
        }),
      }),
    ).model;

    if (Option.isNone(applied.account)) return;
    expect(Option.isNone(applied.account.value.change)).toBe(true);
    expect(Option.isNone(applied.account.value.draft)).toBe(true);
    expect(applied.account.value.pending[0]?.status).toBe("Accepted");
  });

  it("keeps an unknown plan-change outcome retryable with the same id", () => {
    const quotedRequest = update(withChangeDraft("free"), Message.ClickedSubmitAction());

    if (Option.isNone(quotedRequest.model.account)) return;
    const quoting = quotedRequest.model.account.value.change;

    if (Option.isNone(quoting) || quoting.value._tag !== "Quoting") return;
    const requestId = quoting.value.requestId;

    const quoted = update(
      quotedRequest.model,
      Message.ReceivedAdminChange({
        message: AdminChangeCommands.Message.SucceededChangeTier({
          requestId,
          answer: ChangeTierQuoted.make({
            tier: "free",
            proration: { currency: "usd", credit: 1900, charge: 0, due: -1900 },
          }),
        }),
      }),
    ).model;

    const confirmed = update(quoted, Message.ClickedConfirmChangeTier());

    if (Option.isNone(confirmed.model.account)) return;
    const pending = confirmed.model.account.value.pending[0];

    if (pending === undefined) return;

    const unknown = update(
      confirmed.model,
      Message.ReceivedAdminChange({
        message: AdminChangeCommands.Message.FailedChangeTier({
          requestId,
          error: new AdminReadFailed({ reason: "offline", message: "offline" }),
        }),
      }),
    ).model;

    if (Option.isNone(unknown.account)) return;
    expect(unknown.account.value.pending[0]?.status).toBe("Unknown");
    expect(Option.isSome(unknown.account.value.change)).toBe(true);

    const retried = update(unknown, Message.ClickedRetryPending({ commandId: pending.commandId }));
    expect(retried.commands?.map((command) => command.name)).toEqual(["ApplyChangeTier"]);

    if (Option.isNone(retried.model.account)) return;
    expect(retried.model.account.value.pending[0]?.status).toBe("Sending");
  });

  it("closes the open account without touching the list", () => {
    const closed = update(withBilling(), Message.ClosedAccount()).model;
    expect(Option.isNone(closed.account)).toBe(true);
    expect(closed.accounts.rows.length).toBe(1);
  });

  it("boots a catalog page from its URL without an account", () => {
    const plans = init(flags({ catalog: Schema.encodeSync(Catalog)(testCatalog) }), url("/plans"));
    expect(plans.model.route).toEqual(ConsoleRoute.Plans());
    expect(Option.isNone(plans.model.account)).toBe(true);

    const features = init(flags(), url("/features"));
    expect(features.model.route).toEqual(ConsoleRoute.Features());
    expect(Option.isNone(features.model.account)).toBe(true);
  });

  it("boots the overview from its URL", () => {
    const result = init(
      flags({
        catalog: Schema.encodeSync(Catalog)(testCatalog),
        accounts: Schema.encodeSync(BillingReadPage)(page),
      }),
      url("/overview"),
    );

    expect(result.model.route).toEqual(ConsoleRoute.Overview());
    expect(result.commands?.map((command) => command.name)).toEqual(["GetOverview"]);
  });

  it("navigates to the overview and read-only catalog pages", () => {
    const plans = update(seeded(), Message.ClickedPlans());
    expect(plans.model.route).toEqual(ConsoleRoute.Plans());
    expect(Option.isNone(plans.model.account)).toBe(true);
    expect(plans.commands?.find((command) => command.name === "ReflectRoute")?.args).toEqual({
      url: "/plans",
      replace: false,
    });

    const features = update(plans.model, Message.ClickedFeatures());
    expect(features.model.route).toEqual(ConsoleRoute.Features());
    expect(features.commands?.find((command) => command.name === "ReflectRoute")?.args).toEqual({
      url: "/features",
      replace: false,
    });

    const overview = update(features.model, Message.ClickedOverview());
    expect(overview.model.route).toEqual(ConsoleRoute.Overview());
    expect(overview.commands?.find((command) => command.name === "ReflectRoute")?.args).toEqual({
      url: "/overview",
      replace: false,
    });
    expect(overview.commands?.some((command) => command.name === "GetOverview")).toBe(true);
  });

  it("opens the account the URL names and seeds it from flags", () => {
    const snapshot = AccountSnapshot.make({
      account,
      billing,
      entitlements: entitlementsState,
      cursor: 4,
    });

    const result = init(
      flags({
        catalog: Schema.encodeSync(Catalog)(testCatalog),
        accounts: Schema.encodeSync(BillingReadPage)(page),
        account: Schema.encodeSync(AccountSnapshot)(snapshot),
      }),
      url(`/accounts/${account}`),
    );

    // The snapshots seed the views; holds are an entity and are read once.
    expect(result.commands?.map((command) => command.name)).toEqual([
      "GetHolds",
      "GetProviderRefs",
    ]);
    expect(result.model.route._tag).toBe("Account");

    if (Option.isNone(result.model.account)) return;
    const opened = result.model.account.value;
    expect(opened.id).toBe(account);
    expect(Option.isSome(opened.billing)).toBe(true);
    expect(Option.isSome(opened.entitlements)).toBe(true);
    expect(opened.cursor).toEqual(Option.some(4));
    // The feed resumes after the cursor and says it is catching up until it
    // has; a seeded panel is the first frame of the watch, not a live claim.
    expect(opened.feed).toBe("CatchingUp");
  });

  it("falls back to the live reads when a snapshot no longer decodes", () => {
    const result = init(
      flags({ account: { account, billing: { tier: "pro", nope: true } } }),
      url(`/accounts/${account}`),
    );

    expect(result.model.route._tag).toBe("Account");

    if (Option.isNone(result.model.account)) return;
    const opened = result.model.account.value;
    expect(opened.id).toBe(account);
    expect(Option.isNone(opened.billing)).toBe(true);
    expect(Option.isNone(opened.cursor)).toBe(true);
  });

  it("opens an account the URL names even when flags seed nothing", () => {
    const result = init(flags(), url(`/accounts/${account}`, "standing=grace"));
    expect(result.model.route._tag).toBe("Account");
    expect(Option.getOrNull(result.model.accounts.filter.standing)).toBe("grace");

    if (Option.isNone(result.model.account)) return;
    expect(result.model.account.value.id).toBe(account);
    // The list and catalog are still asked for, with the URL's filter, and the
    // open account's holds are read for the first paint.
    expect(result.commands?.map((command) => command.name)).toEqual([
      "GetCatalog",
      "ListAccounts",
      "GetHolds",
      "GetProviderRefs",
    ]);
    const list = result.commands?.find((command) => command.name === "ListAccounts");
    expect(list?.args?.query).toEqual({ standing: "grace" });
  });

  it("reflects the route it follows, and boots the same view from that URL", () => {
    const navigated = update(seeded(), Message.ClickedAccount({ account }));
    // Opening an account reads its holds; the address bar follows the route.
    expect(navigated.commands?.map((command) => command.name).sort()).toEqual([
      "GetHolds",
      "GetProviderRefs",
      "ReflectRoute",
    ]);

    const reflected = navigated.commands?.find((command) => command.name === "ReflectRoute")?.args
      ?.url;

    expect(reflected).toBe(`/accounts/${account}`);

    const refreshed = init(
      flags({
        catalog: Schema.encodeSync(Catalog)(testCatalog),
        accounts: Schema.encodeSync(BillingReadPage)(page),
      }),
      url(String(reflected)),
    ).model;

    expect(refreshed.route).toEqual(navigated.model.route);
    expect(Option.map(refreshed.account, (open) => open.id)).toEqual(Option.some(account));
  });

  it("follows a back button through the URL, resetting the keyed reads", () => {
    const withAccount = update(seeded(), Message.ClickedAccount({ account })).model;
    const backed = update(withAccount, Message.ChangedUrl({ url: url("/") }));
    expect(backed.model.route._tag).toBe("Accounts");
    expect(Option.isNone(backed.model.account)).toBe(true);
    // No navigation echo: the address bar already says what the Model follows.
    expect(backed.commands).toBeUndefined();

    const forward = update(backed.model, Message.ChangedUrl({ url: url(`/accounts/${account}`) }));
    expect(Option.map(forward.model.account, (open) => open.id)).toEqual(Option.some(account));
  });

  it("replaces the URL on a filter change and reads the list once", () => {
    const changed = update(seeded(), Message.UpdatedStandingFilter({ value: "grace" }));
    expect(changed.commands?.map((command) => command.name).sort()).toEqual([
      "ListAccounts",
      "ReflectRoute",
    ]);
    expect(changed.commands?.find((command) => command.name === "ReflectRoute")?.args).toEqual({
      url: "/?standing=grace",
      replace: true,
    });
    expect(Option.getOrNull(changed.model.accounts.filter.standing)).toBe("grace");

    // The runtime echoes the replace back as a URL change; that must not read
    // the list a second time.
    const echoed = update(changed.model, Message.ChangedUrl({ url: url("/", "standing=grace") }));
    expect(echoed.commands).toBeUndefined();
    expect(Option.getOrNull(echoed.model.accounts.filter.standing)).toBe("grace");
  });

  it("keeps a search in the URL and the list query", () => {
    const changed = update(seeded(), Message.UpdatedSearch({ value: "maya" }));

    expect(changed.commands?.map((command) => command.name).sort()).toEqual([
      "ListAccounts",
      "ReflectRoute",
    ]);
    expect(changed.commands?.find((command) => command.name === "ReflectRoute")?.args).toEqual({
      url: "/?search=maya",
      replace: true,
    });
    expect(Option.getOrNull(changed.model.accounts.filter.search)).toBe("maya");

    const echoed = update(changed.model, Message.ChangedUrl({ url: url("/", "search=maya") }));
    expect(echoed.commands).toBeUndefined();
    expect(Option.getOrNull(echoed.model.accounts.filter.search)).toBe("maya");
  });

  it("says when the list was read, and re-reads it after a write", () => {
    const stamped = BillingReadPage.make({ rows: [row], next: null, asOf: at });

    const model = init(
      flags({ accounts: Schema.encodeSync(BillingReadPage)(stamped) }),
      url(),
    ).model;

    expect(model.accounts.asOf).toEqual(Option.some(at));

    const submitted = update(withDraft("250"), Message.ClickedSubmitAction());

    const commandId = submitted.model.account.pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.pending[0]?.commandId)),
      Option.getOrThrow,
    );

    const settled = update(
      submitted.model,
      Message.ReceivedAdminResult({
        message: BillingAdmin.Message.SucceededGrantCredits({
          commandId,
          reply: { balance: 250 },
          receipt: { stream: "Subscription/acct_a", version: 2 },
        }),
      }),
    );

    expect(settled.commands?.map((command) => command.name)).toEqual(["ListAccounts"]);
    // The rows stay while the re-read is in flight; the panel says the list is
    // refreshing rather than blanking what the operator was reading.
    expect(settled.model.accounts.rows.length).toBe(1);
    expect(settled.model.accounts.state).toBe("Loading");

    const requestId = Option.getOrThrow(settled.model.accounts.requestId);

    const reread = update(
      settled.model,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededListAccounts({
          requestId,
          page: BillingReadPage.make({ rows: [row], next: null, asOf: at }),
        }),
      }),
    ).model;

    expect(reread.accounts.state).toBe("Loaded");
    expect(reread.accounts.asOf).toEqual(Option.some(at));
  });

  it("never claims a read time the page does not carry", () => {
    const unstamped = BillingReadPage.make({ rows: [row], next: null });

    const model = init(
      flags({ accounts: Schema.encodeSync(BillingReadPage)(unstamped) }),
      url(),
    ).model;

    expect(Option.isNone(model.accounts.asOf)).toBe(true);
  });

  it("keeps the page cursor in the URL, and re-reads the page it names", () => {
    const paged = BillingReadPage.make({ rows: [row], next: "acct_b" });

    const model = init(
      flags({
        catalog: Schema.encodeSync(Catalog)(testCatalog),
        accounts: Schema.encodeSync(BillingReadPage)(paged),
      }),
      url(),
    ).model;

    const next = update(model, Message.ClickedNextPage());
    expect(next.commands?.map((command) => command.name).sort()).toEqual([
      "ListAccounts",
      "ReflectRoute",
    ]);
    const reflected = next.commands?.find((command) => command.name === "ReflectRoute")?.args?.url;
    expect(reflected).toBe("/?after=acct_b");
    const list = next.commands?.find((command) => command.name === "ListAccounts");
    expect(list?.args?.query).toEqual({ after: "acct_b" });

    // Booting the reflected URL asks for the same page instead of page one.
    const booted = init(flags(), url("/", "after=acct_b"));
    expect(booted.model.route).toEqual(next.model.route);
    const bootList = booted.commands?.find((command) => command.name === "ListAccounts");
    expect(bootList?.args?.query).toEqual({ after: "acct_b" });
  });

  it("re-reads the page a write lands on, not the first page", () => {
    const model = init(flags(), url("/", "after=acct_b")).model;
    const openedAccount = update(model, Message.ClickedAccount({ account })).model;
    const draft = update(openedAccount, Message.ClickedAction({ action: "GrantCredits" })).model;

    const filled = update(
      draft,
      Message.UpdatedDraftField({ field: "amount", value: "250" }),
    ).model;

    const submitted = update(filled, Message.ClickedSubmitAction());

    const commandId = submitted.model.account.pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.pending[0]?.commandId)),
      Option.getOrThrow,
    );

    const settled = update(
      submitted.model,
      Message.ReceivedAdminResult({
        message: BillingAdmin.Message.SucceededGrantCredits({
          commandId,
          reply: { balance: 250 },
          receipt: { stream: "Subscription/acct_a", version: 2 },
        }),
      }),
    );

    const list = settled.commands?.find((command) => command.name === "ListAccounts");
    expect(list?.args?.query).toEqual({ after: "acct_b" });
  });

  it("reads the open account's holds and applies only the current request", () => {
    const model = update(withBilling(), Message.ClickedRefresh()).model;

    const current = model.account.pipe(
      Option.flatMap((value) => value.holds),
      Option.getOrThrow,
    );

    const answer = HoldsAnswer.make({
      account,
      holds: [
        {
          id: "hold-a",
          feature: "messages",
          amount: 400,
          rate: 0,
          cost: 0,
          at,
          expiresAt: at,
          status: "open",
        },
      ],
      asOf: at,
    });

    const applied = update(
      model,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededHolds({ requestId: current.requestId, answer }),
      }),
    ).model;

    expect(
      applied.account.pipe(
        Option.flatMap((value) => value.holds),
        Option.map((holds) => holds.holds.map((hold) => hold.id)),
        Option.getOrThrow,
      ),
    ).toEqual(["hold-a"]);

    const stale = update(
      applied,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededHolds({
          requestId: current.requestId + 1,
          answer: HoldsAnswer.make({ account, holds: [], asOf: at }),
        }),
      }),
    ).model;

    expect(
      stale.account.pipe(
        Option.flatMap((value) => value.holds),
        Option.map((holds) => holds.holds.length),
        Option.getOrThrow,
      ),
    ).toBe(1);

    // An answer for another account never reaches this account's panel.
    const foreign = update(
      applied,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededHolds({
          requestId: current.requestId,
          answer: HoldsAnswer.make({ account: "acct_other", holds: [], asOf: at }),
        }),
      }),
    ).model;

    expect(
      foreign.account.pipe(
        Option.flatMap((value) => value.holds),
        Option.map((holds) => holds.holds.length),
        Option.getOrThrow,
      ),
    ).toBe(1);
  });

  it("reads provider refs and applies only the current answer", () => {
    const opened = update(seeded(), Message.ClickedAccount({ account })).model;

    const state = opened.account.pipe(
      Option.flatMap((value) => value.providerRefs),
      Option.getOrThrow,
    );

    const applied = update(
      opened,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededProviderRefs({
          requestId: state.requestId,
          answer: {
            account,
            refs: { manual: { customer: "cus_1", subscription: "sub_1" } },
            asOf: at,
          },
        }),
      }),
    ).model;

    const refs = applied.account.pipe(
      Option.flatMap((value) => value.providerRefs),
      Option.getOrThrow,
    );

    expect(refs.state).toBe("Loaded");
    expect(refs.refs.manual?.customer).toBe("cus_1");

    const event = update(
      applied,
      Message.ReceivedEvent({
        seq: 1,
        at,
        commandId: "cmd_refs",
        tag: "ProviderRefAttached",
        body: "{}",
        event: {
          _tag: "ProviderRefAttached",
          provider: "manual",
          refs: { customer: "cus_2" },
        } as never,
      }),
    );

    expect(event.commands?.map((command) => command.name)).toEqual(["GetProviderRefs"]);
  });

  it("re-reads holds when the event feed says one moved", () => {
    const model = update(withBilling(), Message.ClickedRefresh()).model;

    const reserved = update(
      model,
      Message.ReceivedEvent({
        seq: 1,
        at,
        commandId: "cmd_1",
        tag: "UsageReserved",
        body: "{}",
        event: new UsageReserved({
          holdId: "hold_1",
          feature: "messages",
          amount: 1,
          rate: 0,
          cost: 0,
          at,
          expiresAt: at,
          remainingAfter: 1,
        }),
      }),
    );

    expect(reserved.commands?.map((command) => command.name)).toEqual(["GetHolds"]);

    const unrelated = update(
      model,
      Message.ReceivedEvent({
        seq: 2,
        at,
        commandId: "cmd_2",
        tag: "CreditsGranted",
        body: "{}",
        event: new CreditsGranted({ amount: 1, balanceAfter: 1 }),
      }),
    );

    expect(unrelated.commands).toBeUndefined();
  });

  it("folds the event feed into a usage timeline, once, in order", () => {
    const periodEnd = DateTime.makeUnsafe("2030-02-01T00:00:00Z");

    const sequence = [
      Message.ReceivedEvent({
        seq: 1,
        at,
        commandId: "cmd_1",
        tag: "SubscriptionActivated",
        body: "{}",
        event: new SubscriptionActivated({
          tier: "pro",
          allowances: {},
          remaining: {},
          credits: 100,
          creditsExpire: "period",
          rates: {},
          periodStart: at,
          periodEnd,
          anchorTz: "UTC",
          interval: "month",
          statusAfter: "active",
        }),
      }),
      Message.ReceivedEvent({
        seq: 2,
        at,
        commandId: "cmd_2",
        tag: "UsageRecorded",
        body: "{}",
        event: new UsageRecorded({
          feature: "messages",
          amount: 150,
          cost: 0,
          creditsAfter: 100,
          usedAfter: 150,
          remainingAfter: -50,
          charge: 100,
          billedAfter: 100,
          unitPrice: { amount: 2, currency: "usd" },
          billable: 50,
        }),
      }),
      Message.ReceivedEvent({
        seq: 3,
        at,
        commandId: "cmd_3",
        tag: "CreditsGranted",
        body: "{}",
        event: new CreditsGranted({ amount: 50, balanceAfter: 150 }),
      }),
    ];

    const received = sequence.reduce(
      (current, message) => update(current, message).model,
      withBilling(),
    );

    // A redelivered event is the same sequence number: the fold ignores it.
    const replayed = update(received, sequence[1]!).model;

    if (Option.isNone(replayed.account)) return;
    const timeline = replayed.account.value.timeline;

    expect(timeline.entries.map((entry) => entry.kind)).toEqual([
      "started",
      "usage",
      "credit-grant",
    ]);
    expect(timeline.periods[0]?.features.messages).toEqual({
      units: 150,
      credits: 0,
      charge: 100,
      held: 0,
      settled: 0,
      released: 0,
    });
    expect(timeline.periods[0]?.credits).toEqual({
      granted: 150,
      purchased: 0,
      spent: 0,
      expired: 0,
      balanceAfter: 150,
    });
  });

  it("asks the model what a command would do, and records nothing", () => {
    const model = update(withBilling(), Message.UpdatedPreviewTier({ value: "free" })).model;

    const asked = update(
      model,
      Message.ClickedPreview({ command: { kind: "changeTier", tier: "free" } }),
    );

    expect(asked.commands?.map((command) => command.name)).toEqual(["PreviewCommand"]);
    expect(asked.commands?.[0]?.args?.input).toEqual({
      account,
      command: { kind: "changeTier", tier: "free" },
    });
    // No command id was allocated: a preview never looks like a write.
    expect(asked.model.commandIds.sent).toBe(0);

    const requestId = asked.model.account.pipe(
      Option.flatMap((value) => value.preview),
      Option.map((preview) => preview.requestId),
      Option.getOrThrow,
    );

    const rejected = update(
      asked.model,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededPreview({
          requestId,
          answer: PreviewRejected.make({ rejection: new NotSubscribed({ account }) }),
        }),
      }),
    ).model;

    expect(
      rejected.account.pipe(
        Option.flatMap((value) => value.preview),
        Option.map((preview) => preview.state),
        Option.getOrThrow,
      ),
    ).toBe("Answered");

    // A late answer to an earlier question is dropped.
    const stale = update(
      rejected,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededPreview({
          requestId: requestId + 1,
          answer: PreviewUnpredictable.make({ reason: "stale" }),
        }),
      }),
    ).model;

    expect(
      stale.account.pipe(
        Option.flatMap((value) => value.preview),
        Option.flatMap((preview) => preview.answer),
        Option.map((answer) => answer._tag),
        Option.getOrThrow,
      ),
    ).toBe("rejected");
  });

  it("applies an accepted preview without turning it into a write", () => {
    const asked = update(withBilling(), Message.ClickedPreview({ command: { kind: "cancel" } }));

    const requestId = asked.model.account.pipe(
      Option.flatMap((value) => value.preview),
      Option.map((preview) => preview.requestId),
      Option.getOrThrow,
    );

    const answered = update(
      asked.model,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededPreview({
          requestId,
          answer: PreviewAccepted.make({
            state: { _tag: "Unsubscribed", refs: {} },
            events: [],
          }),
        }),
      }),
    ).model;

    if (Option.isNone(answered.account)) return;
    expect(answered.account.value.pending).toEqual([]);
    expect(answered.commandIds.sent).toBe(0);
  });

  it("verifies the open account against the deploy", () => {
    const asked = update(withBilling(), Message.ClickedVerify());
    expect(asked.commands?.map((command) => command.name)).toEqual(["VerifyAccount"]);

    const requestId = asked.model.account.pipe(
      Option.flatMap((value) => value.verify),
      Option.map((verify) => verify.requestId),
      Option.getOrThrow,
    );

    const answered = update(
      asked.model,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededVerify({ requestId, mismatches: [] }),
      }),
    ).model;

    expect(
      answered.account.pipe(
        Option.flatMap((value) => value.verify),
        Option.map((verify) => verify.state),
        Option.getOrThrow,
      ),
    ).toBe("Answered");
    expect(
      answered.account.pipe(
        Option.flatMap((value) => value.verify),
        Option.map((verify) => verify.mismatches.length),
        Option.getOrThrow,
      ),
    ).toBe(0);
  });
});

describe("a change at the period end", () => {
  it("sends the schedule with the catalog's terms and no quote", () => {
    const result = update(withScheduleDraft("free"), Message.ClickedSubmitAction());
    // No server round trip: a scheduled change carries no proration, so the
    // console builds it from the catalog it holds.
    expect(result.commands?.map((command) => command.name)).toEqual(["ScheduleTierChange"]);
    expect(result.commands?.[0]?.args?.input).toMatchObject({
      tier: "free",
      credits: 0,
      creditsExpire: "period",
      rates: {},
    });
  });

  it("sends a scheduled change at the standing's currency", () => {
    const bilingual = plan({
      id: "bilingual",
      price: {
        amount: 1_900,
        currency: "usd",
        interval: "month",
        additionalCurrencies: [{ currency: "eur", amount: 1_800 }],
      },
      grants: [planItem(messages, { included: 2_000 })],
    });

    const multi = Effect.runSync(catalog({ features: [messages], tiers: [free, pro, bilingual] }));

    const seeded = init(
      flags({
        catalog: Schema.encodeSync(Catalog)(multi),
        accounts: Schema.encodeSync(BillingReadPage)(page),
      }),
      url(),
    ).model;

    const opened = update(seeded, Message.ClickedAccount({ account })).model;

    const inEuros = update(
      opened,
      Message.ReceivedBilling({
        state: Option.some({ ...billing, currency: "eur" }),
      }),
    ).model;

    const draft = update(inEuros, Message.ClickedAction({ action: "ScheduleTierChange" })).model;

    const filled = update(
      draft,
      Message.UpdatedDraftField({ field: "tier", value: "bilingual" }),
    ).model;

    const result = update(filled, Message.ClickedSubmitAction());
    expect(result.commands?.map((command) => command.name)).toEqual(["ScheduleTierChange"]);
    expect(
      (
        result.commands?.[0]?.args as {
          readonly input?: { readonly price?: { readonly currency?: string } };
        }
      )?.input?.price?.currency,
    ).toBe("eur");
  });

  it("sends a withdrawal for the scheduled change", () => {
    const opened = update(withBilling(), Message.ClickedAction({ action: "WithdrawTierChange" }));
    const result = update(opened.model, Message.ClickedSubmitAction());
    expect(result.commands?.map((command) => command.name)).toEqual(["WithdrawTierChange"]);
    expect(result.commands?.[0]?.args?.input).toEqual({});
  });
});
