import { describe, expect, it } from "@alchemy.run/test";
import {
  AccountId,
  BillingAdminApi,
  BillingReadPage,
  Catalog,
  allowance,
  catalog,
  messages,
  tier,
} from "@potion.run/paykit";
import { ChangeTierApplied, ChangeTierQuoted } from "@potion.run/paykit/Admin";
import { AdminChangeCommands, AdminQueries, BillingAdmin } from "@potion.run/paykit/Foldkit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Flags } from "../src/Flags.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/Message.ts";
import { ConsoleAction, Model } from "../src/Model.ts";
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
    );
    expect(result.commands).toBeUndefined();
    expect(Option.isSome(result.model.catalog)).toBe(true);
    expect(result.model.accounts.rows.length).toBe(1);
    expect(result.model.accounts.state).toBe("Loaded");
  });

  it("asks for the catalog and the first page when flags do not seed them", () => {
    const result = init(flags());
    expect(result.commands?.map((command) => command.name)).toEqual(["GetCatalog", "ListAccounts"]);
    expect(result.model.accounts.state).toBe("Loading");
  });

  it("applies a list page only for the request it answers", () => {
    const model = init(flags()).model;
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

  it("closes the open account without touching the list", () => {
    const closed = update(withBilling(), Message.ClosedAccount()).model;
    expect(Option.isNone(closed.account)).toBe(true);
    expect(closed.accounts.rows.length).toBe(1);
  });
});
