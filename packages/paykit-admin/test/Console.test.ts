import { describe, expect, it } from "@alchemy.run/test";
import {
  AccountId,
  BillingAdminApi,
  BillingReadPage,
  Catalog,
  NotSubscribed,
  allowance,
  catalog,
  messages,
  tier,
} from "@potion.run/paykit";
import { AdminReadFailed, ChangeTierApplied, ChangeTierQuoted } from "@potion.run/paykit/Admin";
import { AdminChangeCommands, AdminQueries, BillingAdmin } from "@potion.run/paykit/Foldkit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Url } from "foldkit/url";
import { Flags } from "../src/Flags.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/Message.ts";
import { ConsoleAction, Model } from "../src/Model.ts";
import { AccountSnapshot } from "../src/Snapshot.ts";
import { update } from "../src/update.ts";

const free = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const pro = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
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

const billing = {
  account: account,
  tier: "pro",
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

const withBilling = (): Model =>
  update(opened(), Message.ReceivedBilling({ state: Option.some(billing) })).model;

const withDraft = (amount: string): Model => {
  const model = withBilling();
  const openedDraft = update(model, Message.ClickedAction({ action: "GrantCredits" })).model;
  return update(openedDraft, Message.UpdatedDraftField({ field: "amount", value: amount })).model;
};

const withChangeDraft = (tier: string): Model => {
  const model = withBilling();
  const openedDraft = update(model, Message.ClickedAction({ action: "ChangeTier" })).model;
  return update(openedDraft, Message.UpdatedDraftField({ field: "tier", value: tier })).model;
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

  it("covers every admin Api command", () => {
    const covered = [...ConsoleAction].sort();
    const served = BillingAdminApi.commands.map((command) => command.tag).sort();
    expect(covered).toEqual(served);
  });

  it("quotes a tier change, then applies only the confirmed amount", () => {
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

  it("keeps an unknown tier-change outcome retryable with the same id", () => {
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
    expect(result.commands).toBeUndefined();
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
    // The list and catalog are still asked for, with the URL's filter.
    expect(result.commands?.map((command) => command.name)).toEqual(["GetCatalog", "ListAccounts"]);
    const list = result.commands?.find((command) => command.name === "ListAccounts");
    expect(list?.args?.query).toEqual({ standing: "grace" });
  });

  it("reflects the route it follows, and boots the same view from that URL", () => {
    const navigated = update(seeded(), Message.ClickedAccount({ account }));
    expect(navigated.commands?.map((command) => command.name)).toEqual(["ReflectRoute"]);
    const reflected = navigated.commands?.[0]?.args?.url;
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
});
