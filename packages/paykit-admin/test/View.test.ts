import { describe, expect, it } from "@alchemy.run/test";
import {
  AccountId,
  BillingReadPage,
  Catalog,
  allowance,
  catalog,
  messages,
  tier,
} from "@potion.run/paykit";
import { BillingOverview } from "@potion.run/paykit/Admin";
import { AdminQueries } from "@potion.run/paykit/Foldkit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HtmlBuilder } from "foldkit/html";
import { inertHtml } from "foldkit/html";
import type { Url } from "foldkit/url";
import { devToolsTabs } from "../src/DevTools.ts";
import { Flags } from "../src/Flags.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/Message.ts";
import type { Model } from "../src/Model.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";

const free = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const pro = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [free, pro] }));
const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const account = AccountId.make("acct_a");

const page = BillingReadPage.make({
  rows: [
    {
      account,
      tier: "pro",
      status: "active",
      standing: "good",
      periodStart: at,
      periodEnd: at,
      cancelAtPeriodEnd: false,
      credits: 0,
      dunningAttempts: 0,
      currency: "usd",
      features: {},
    },
  ],
  next: null,
});

const url = (pathname = "/"): Url => ({
  protocol: "https:",
  host: "admin.test",
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
});

const model = (devTools: boolean, pathname = "/"): Model =>
  init(
    Flags.make({
      session: "session-1",
      devTools,
      catalog: Schema.encodeSync(Catalog)(testCatalog),
      accounts: Schema.encodeSync(BillingReadPage)(page),
    }),
    url(pathname),
  ).model;

const render = (value: Model) => view(value, inertHtml as unknown as HtmlBuilder<Message>);

describe("the console view", () => {
  it("renders the page without the lab when dev tools are off", () => {
    expect(render(model(false)).title).toBe("Paykit admin");
  });

  it("renders every lab tab without an open account", () => {
    const opened = update(model(true), Message.ToggledDevTools({ isOpen: true })).model;
    for (const { tab } of devToolsTabs) {
      const selected = update(opened, Message.SelectedDevToolsTab({ tab })).model;
      expect(render(selected).title).toBe("Paykit admin");
    }
  });

  it("renders the overview page", () => {
    expect(render(model(false, "/overview")).title).toBe("Paykit admin");
  });

  it("renders a loaded overview with charts", () => {
    const base = model(false, "/overview");
    const requestId = Option.getOrThrow(base.overview).requestId;
    const overview = BillingOverview.make({
      asOf: at,
      accounts: 3,
      byStatus: [
        { status: "trialing", count: 1 },
        { status: "active", count: 1 },
        { status: "grace", count: 1 },
        { status: "canceled", count: 0 },
        { status: "expired", count: 0 },
      ],
      byStanding: [
        { standing: "good", count: 2 },
        { standing: "grace", count: 1 },
        { standing: "blocked", count: 0 },
      ],
      byTier: [
        { tier: "free", count: 1 },
        { tier: "pro", count: 2 },
      ],
      revenue: [
        {
          currency: "usd",
          mrr: 3_800,
          arr: 45_600,
          trialPipeline: 1_900,
          atRisk: 1_900,
          churned: 0,
        },
      ],
    });
    const loaded = update(
      base,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededOverview({ requestId, overview }),
      }),
    ).model;
    expect(render(loaded).title).toBe("Paykit admin");
  });

  it("renders the catalog pages read only", () => {
    expect(render(model(false, "/plans")).title).toBe("Paykit admin");
    expect(render(model(false, "/features")).title).toBe("Paykit admin");
  });

  it("renders every lab tab with a seeded account", () => {
    const opened = update(model(true), Message.ToggledDevTools({ isOpen: true })).model;
    const withAccount = update(opened, Message.ClickedOpenDevToolsAccount()).model;
    for (const { tab } of devToolsTabs) {
      const selected = update(withAccount, Message.SelectedDevToolsTab({ tab })).model;
      expect(render(selected).title).toBe("Paykit admin");
    }
  });
});
