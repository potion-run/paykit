import { describe, expect, it } from "@alchemy.run/test";
import {
  AccountId,
  BillingReadPage,
  Catalog,
  Subscription,
  planItem,
  catalog,
  messages,
  plan,
} from "@potion.run/paykit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Url } from "foldkit/url";
import { decodeDevToolsEvent, devToolsEvents, subscriptionEventTags } from "../src/DevTools.ts";
import { Flags } from "../src/Flags.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/Message.ts";
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
  account,
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

const url = (pathname = "/"): Url => ({
  protocol: "https:",
  host: "admin.test",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

const flags = (devTools: boolean): Flags =>
  Flags.make({
    session: "session-1",
    devTools,
    catalog: Schema.encodeSync(Catalog)(testCatalog),
    accounts: Schema.encodeSync(BillingReadPage)(page),
  });

const seeded = (devTools: boolean) => init(flags(devTools), url()).model;

const opened = (devTools = true) => {
  const model = seeded(devTools);

  return update(model, Message.ClickedAccount({ account })).model;
};

const openAccount = (model: ReturnType<typeof opened>) => {
  if (Option.isNone(model.account)) throw new Error("expected an open account");

  return model.account.value;
};

describe("the event lab", () => {
  it("names every aggregate event, with a parseable body", () => {
    const tags = devToolsEvents.map((event) => event.tag).toSorted();
    expect(tags).toEqual(subscriptionEventTags.toSorted());
    expect(tags).toEqual(Subscription.definition.events.map((event) => event.tag).toSorted());

    for (const event of devToolsEvents) {
      const parsed = JSON.parse(event.body) as unknown;
      expect(typeof parsed).toBe("object");
      expect(Option.isSome(decodeDevToolsEvent(event))).toBe(true);
    }
  });

  it("stays inert unless the host seeds `devTools`", () => {
    const model = opened(false);
    expect(model.devTools.isEnabled).toBe(false);
    const toggled = update(model, Message.ToggledDevTools({ isOpen: true })).model;
    expect(toggled.devTools.isOpen).toBe(false);
    const tabbed = update(toggled, Message.SelectedDevToolsTab({ tab: "feed" })).model;
    expect(tabbed.devTools.tab).toBe("events");
    const emitted = update(tabbed, Message.ClickedEmitAllDevToolsEvents());
    expect(emitted.commands).toBeUndefined();
    expect(openAccount(toggled).events).toEqual([]);
  });

  it("switches the floating panel's tabs", () => {
    const model = opened();
    expect(model.devTools.tab).toBe("events");
    const reads = update(model, Message.SelectedDevToolsTab({ tab: "reads" })).model;
    expect(reads.devTools.tab).toBe("reads");
    const feed = update(reads, Message.SelectedDevToolsTab({ tab: "feed" })).model;
    expect(feed.devTools.tab).toBe("feed");
  });

  it("emits the selected event at the account's next sequence", () => {
    const model = opened();
    const event = devToolsEvents.find((candidate) => candidate.tag === "CreditsGranted");

    if (event === undefined) throw new Error("expected a CreditsGranted default");

    const result = update(
      update(model, Message.UpdatedDevToolsEventTag({ value: event.tag })).model,
      Message.ClickedEmitDevToolsEvent(),
    );

    const account = openAccount(result.model);
    expect(account.events[0]?.tag).toBe("CreditsGranted");
    expect(account.events[0]?.seq).toBe(1);
    expect(account.events[0]?.body).toBe(event.body);
    expect(account.cursor).toEqual(Option.some(1));
    expect(result.model.devTools.emitted).toBe(1);
    expect(account.timeline.entries[0]?.kind).toBe("credit-grant");

    const again = update(result.model, Message.ClickedEmitDevToolsEvent()).model;
    expect(openAccount(again).events[0]?.seq).toBe(2);
    expect(again.devTools.emitted).toBe(2);
  });

  it("opens the lab account when emitting with nothing open", () => {
    const model = seeded(true);
    expect(Option.isNone(model.account)).toBe(true);

    const result = update(model, Message.ClickedEmitDevToolsEvent());
    const account = openAccount(result.model);
    expect(account.id).toBe("acct_dev");
    expect(account.events[0]?.tag).toBe(devToolsEvents[0]?.tag);
    expect(Option.isSome(account.billing)).toBe(true);
    expect(result.commands?.map((command) => command.name)).toEqual([
      "GetHolds",
      "GetProviderRefs",
      "ReflectRoute",
    ]);
  });

  it("emits every event, in order, and re-reads holds for the hold events", () => {
    const result = update(opened(), Message.ClickedEmitAllDevToolsEvents());
    const account = openAccount(result.model);
    expect(account.events.length).toBe(devToolsEvents.length);
    expect(account.cursor).toEqual(Option.some(devToolsEvents.length));
    expect(result.model.devTools.emitted).toBe(devToolsEvents.length);
    // UsageReserved, UsageSettled and UsageReleased each move a hold, so the
    // entity read is re-issued; the lab exercises the same path as the feed.
    expect(result.commands?.map((command) => command.name)).toEqual([
      "GetHolds",
      "GetHolds",
      "GetHolds",
      "GetProviderRefs",
    ]);
  });

  it("resets the event body when the tag changes", () => {
    const model = opened();
    const event = devToolsEvents.find((candidate) => candidate.tag === "UsageReserved");

    if (event === undefined) throw new Error("expected a UsageReserved default");
    const changed = update(model, Message.UpdatedDevToolsEventTag({ value: event.tag })).model;
    expect(changed.devTools.eventBody).toBe(event.body);
  });

  it("seeds the standing, the allowances and the holds", () => {
    const seededModel = update(opened(), Message.ClickedSeedDevToolsSnapshot()).model;
    const withStanding = openAccount(seededModel);
    expect(Option.isSome(withStanding.billing)).toBe(true);
    expect(Option.isSome(withStanding.entitlements)).toBe(true);

    if (Option.isSome(withStanding.entitlements)) {
      expect(Object.keys(withStanding.entitlements.value.features)).toContain("messages");
      // The seeded holds are folded into the planItem view, not a second count.
      expect(withStanding.entitlements.value.features.messages?.reserved).toBe(160);
    }

    const seededHolds = withStanding.holds;

    if (Option.isNone(seededHolds)) throw new Error("expected seeded holds");
    expect(seededHolds.value.state).toBe("Loaded");
    expect(seededHolds.value.holds.length).toBe(3);
    expect(seededHolds.value.holds.filter((hold) => hold.status === "open").length).toBe(2);
    expect(seededHolds.value.holds.some((hold) => hold.status === "settled")).toBe(true);

    const seededRefs = withStanding.providerRefs;

    if (Option.isNone(seededRefs)) throw new Error("expected seeded provider refs");
    expect(seededRefs.value.state).toBe("Loaded");
    expect(seededRefs.value.refs.manual?.customer).toBe("cus_acct_a");
  });

  it("seeds a configured account into the local list", () => {
    const configured = update(
      update(
        update(seeded(true), Message.UpdatedDevToolsSeedTier({ value: "pro" })).model,
        Message.UpdatedDevToolsSeedStatus({ value: "grace" }),
      ).model,
      Message.UpdatedDevToolsSeedCredits({ value: "777" }),
    ).model;

    const result = update(configured, Message.ClickedSeedDevToolsSnapshot());
    const account = openAccount(result.model);
    const billing = account.billing.pipe(Option.getOrThrow);
    expect(billing.tier).toBe("pro");
    expect(billing.status).toBe("grace");
    expect(billing.credits).toBe(777);
    expect(result.model.accounts.rows.some((row) => row.account === "acct_dev")).toBe(true);
    expect(result.model.devTools.labRows.length).toBe(1);
  });

  it("seeds and clears a varied lab account set", () => {
    const seededModel = update(seeded(true), Message.ClickedSeedDevToolsAccounts()).model;
    expect(seededModel.devTools.labRows.length).toBe(12);
    expect(
      seededModel.accounts.rows.filter((row) => row.account.startsWith("acct_demo_")).length,
    ).toBe(12);

    const cleared = update(seededModel, Message.ClickedClearDevToolsAccounts()).model;
    expect(cleared.devTools.labRows.length).toBe(0);
    expect(cleared.accounts.rows.filter((row) => row.account.startsWith("acct_demo_")).length).toBe(
      0,
    );
  });

  it("opens an account from the lab when the list has no row for it", () => {
    const model = update(
      seeded(true),
      Message.UpdatedDevToolsAccountId({ value: "acct_empty" }),
    ).model;

    expect(Option.isNone(model.account)).toBe(true);

    const result = update(model, Message.ClickedOpenDevToolsAccount());
    expect(result.commands?.map((command) => command.name)).toEqual([
      "GetHolds",
      "GetProviderRefs",
      "ReflectRoute",
    ]);
    const account = openAccount(result.model);
    expect(account.id).toBe("acct_empty");
    expect(Option.isSome(account.billing)).toBe(true);
    expect(Option.isSome(account.entitlements)).toBe(true);

    if (Option.isNone(account.holds)) throw new Error("expected seeded holds");
    expect(account.holds.value.holds.length).toBe(3);
  });

  it("simulates the feed and read states, then resets them", () => {
    const caughtUp = update(opened(), Message.ClickedCatchUpDevToolsFeed()).model;
    expect(openAccount(caughtUp).feed).toBe("Live");

    const failedFeed = update(caughtUp, Message.ClickedFailDevToolsFeed()).model;
    expect(openAccount(failedFeed).feed).toBe("Failed");
    expect(Option.isSome(openAccount(failedFeed).error)).toBe(true);

    const failedReads = update(failedFeed, Message.ClickedFailDevToolsReads()).model;
    expect(Option.isSome(openAccount(failedReads).error)).toBe(true);

    const reset = update(failedReads, Message.ClickedResetDevTools()).model;
    const account = openAccount(reset);
    expect(account.feed).toBe("CatchingUp");
    expect(account.events).toEqual([]);
    expect(account.cursor).toEqual(Option.none());
    expect(account.error).toEqual(Option.none());
    expect(reset.devTools.emitted).toBe(0);
  });
});
