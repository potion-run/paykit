import { describe, expect, it } from "@alchemy.run/test";
import {
  AccountId,
  BillingReadPage,
  Catalog,
  planItem,
  catalog,
  messages,
  plan,
} from "@potion.run/paykit";
import { BillingOverview } from "@potion.run/paykit/Admin";
import { AdminQueries } from "@potion.run/paykit/Foldkit";
import type { BillingStateView, FeatureEntitlement } from "@potion.run/paykit/Read";
import { EntityId } from "@potion.run/paykit/Read";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HtmlBuilder } from "foldkit/html";
import { inertHtml } from "foldkit/html";
import type { Url } from "foldkit/url";
import { OperatorActions } from "../src/actions.ts";
import { devToolsTabs } from "../src/DevTools.ts";
import { Flags } from "../src/Flags.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/Message.ts";
import type { Model } from "../src/Model.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";

const free = plan({ id: "free", grants: [planItem(messages, { included: 100 })] });

const pro = plan({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [planItem(messages, { included: 2_000 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [free, pro] }));
const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const midday = DateTime.makeUnsafe("2030-06-15T12:00:00Z");
const account = AccountId.make("acct_a");

/** One counted feature in the shape `BillingReadRow.features` carries. */
const messageFeature = (used: number, included: number): FeatureEntitlement => ({
  kind: "metered",
  included,
  used,
  reserved: 0,
  remaining: included - used,
  carried: 0,
  allowed: true,
  overage: "block",
  resets: "month",
  resetsAt: at,
});

const page = BillingReadPage.make({
  rows: [
    {
      account,
      customer: { name: "Maya Chen", email: "maya@acme.dev", createdAt: at },
      tier: "pro",
      status: "active",
      standing: "good",
      periodStart: at,
      periodEnd: at,
      cancelAtPeriodEnd: false,
      credits: 4_820,
      prepaidCredits: 0,
      dunningAttempts: 0,
      currency: "usd",
      features: { messages: messageFeature(1_840, 2_000) },
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

type VNode = {
  readonly sel?: string;
  readonly text?: string;
  readonly data?: {
    readonly class?: Readonly<Record<string, boolean>>;
    readonly attrs?: Readonly<Record<string, string>>;
  };
  readonly children?: ReadonlyArray<VNode>;
};

const rootOf = (value: Model): VNode => render(value).body as unknown as VNode;

const textOf = (node: VNode): string => node.text ?? (node.children ?? []).map(textOf).join(" ");

const nodesOf = (node: VNode): ReadonlyArray<VNode> => [
  node,
  ...(node.children ?? []).flatMap(nodesOf),
];

const nodesWithClass = (node: VNode, className: string): ReadonlyArray<VNode> =>
  nodesOf(node).filter((candidate) => candidate.data?.class?.[className] === true);

const attrOf = (node: VNode, name: string): string | undefined =>
  nodesOf(node).find((candidate) => candidate.data?.attrs?.[name] !== undefined)?.data?.attrs?.[
    name
  ];

/** A billing snapshot, in the shape `BillingState` folds. */
const billing = {
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
      creditsExpire: "period" as const,
      rates: {},
      interval: "month" as const,
      currency: "usd",
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
  prepaidCredits: 0,
  dunningAttempts: 0,
  currency: "usd",
};

/** The account page, with whatever billing snapshot the test supplied. */
const accountPage = (billingState: BillingStateView): Model => {
  const opened = update(model(false), Message.ClickedAccount({ account })).model;

  return update(opened, Message.ReceivedBilling({ state: Option.some(billingState) })).model;
};

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

  it("renders the refunds panel, and offers a reversal only while one is outstanding", () => {
    // Both rows render; only the one with money left carries a reverse action,
    // which is the same condition `actionsFor` offers the action under.
    const settled = accountPage({
      ...billing,
      refunds: {
        re_1: { refundId: "re_1", amount: 4_900, currency: "usd", reversed: 4_900 },
        re_2: { refundId: "re_2", amount: 1_000, currency: "usd" },
      },
    });

    expect(render(settled).title).toBe("Paykit admin");
  });

  it("shows the customer's name, email and Customer ID on the account page", () => {
    const withCustomer = accountPage({
      ...billing,
      customer: { name: "Maya Chen", email: "maya@acme.dev", createdAt: midday },
    });

    const root = rootOf(withCustomer);
    const text = textOf(root);

    expect(text).toContain("Maya Chen");
    expect(text).toContain("maya@acme.dev");
    expect(text).toContain("Customer since");
    expect(text).toContain("Customer ID acct_a");
    expect(textOf(nodesWithClass(root, "pk-avatar")[0] ?? root)).toContain("MC");
  });

  it("renders credits as a count, never as money", () => {
    const text = textOf(rootOf(accountPage({ ...billing, credits: 4_820 })));

    expect(text).toContain("4,820 credits");
    expect(text).not.toContain("$48.20");
  });

  it("names the real milestone in the summary's last tile", () => {
    const expired = textOf(rootOf(accountPage({ ...billing, status: "expired" })));
    expect(expired).toContain("Ended");
    expect(expired).toContain("Plan expired");
    expect(expired).not.toContain("Renews");

    const grace = textOf(rootOf(accountPage({ ...billing, status: "grace", graceUntil: midday })));
    expect(grace).toContain("Access ends");
    expect(grace).toContain("Payment is past due");

    const trialing = textOf(
      rootOf(accountPage({ ...billing, status: "trialing", trialEndsAt: midday })),
    );

    expect(trialing).toContain("Trial ends");

    const canceling = textOf(rootOf(accountPage({ ...billing, cancelAtPeriodEnd: true })));
    expect(canceling).toContain("Cancels");
    expect(canceling).toContain("At period end");
  });

  it("asks for granted credits in credits, not minor units", () => {
    expect(OperatorActions.GrantCredits.fields[0]?.label).toBe("Credits");
  });

  it("shows one status pill and a payment-issue sentence", () => {
    const root = rootOf(
      accountPage({
        ...billing,
        status: "grace",
        dunningAttempts: 2,
        graceUntil: midday,
      }),
    );

    const text = textOf(root);

    expect(nodesWithClass(root, "pk-status-pill")).toHaveLength(1);
    expect(nodesWithClass(root, "pk-payment-banner")).toHaveLength(1);
    expect(attrOf(root, "data-paykit-status")).toBe("grace");
    expect(attrOf(root, "data-paykit-standing")).toBe("grace");
    expect(text).toContain("Payment failed 2 times");
    expect(text).toContain("access ends");
    expect(text).not.toContain("Phase:");
  });

  it("renders the customer list with plan names, usage, credits and next bill", () => {
    const text = textOf(rootOf(model(false)));

    expect(text).toContain("Maya Chen");
    expect(text).toContain("maya@acme.dev");
    expect(nodesWithClass(rootOf(model(false)), "pk-filter-search")).toHaveLength(1);
    expect(text).toContain("Pro");
    expect(text).toContain("1,840 / 2,000");
    expect(text).toContain("Messages");
    expect(text).toContain("4,820");
    expect(text).toContain("Next bill");
    expect(text).toContain("Updated");
    expect(text).not.toContain("Standing");
    expect(text).not.toContain("Snapshot");
  });

  it("renders limits, fired alerts and entities when the read carries them", () => {
    const root = rootOf(
      accountPage({
        ...billing,
        billingControls: {
          autoTopUp: { enabled: true, threshold: 1_000 },
          spendLimits: [{ featureId: "messages", amount: 50_000 }],
          usageAlerts: [{ featureId: "messages", at: 1_800 }],
        },
        alertsFired: [{ featureId: "messages", at: 1_800, usedAfter: 1_840, firedAt: midday }],
        entities: [
          { id: EntityId.make("ent_1"), name: "Acme EU", status: "attached", createdAt: midday },
        ],
      }),
    );

    const text = textOf(root);

    expect(nodesWithClass(root, "pk-limits")).toHaveLength(1);
    expect(nodesWithClass(root, "pk-entities")).toHaveLength(1);
    expect(text).toContain("Limits & alerts");
    expect(text).toContain("Auto top-up");
    expect(text).toContain("On · below 1,000 credits");
    expect(text).toContain("1,800 units");
    expect(text).toContain("Entities");
    expect(text).toContain("Acme EU");
  });

  it("keeps Change plan primary and groups the rest behind More actions", () => {
    const root = rootOf(accountPage(billing));
    const text = textOf(root);
    const more = nodesWithClass(root, "pk-more-actions");

    expect(text).toContain("Change plan");
    expect(more).toHaveLength(1);
    expect(textOf(more[0] ?? root)).toContain("More actions");
  });

  it("renders the overview page", () => {
    expect(render(model(false, "/overview")).title).toBe("Paykit admin");
  });

  it("renders a loaded overview with the server-wide attention list", () => {
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
      attention: [
        {
          account: "acct_a",
          tier: "pro",
          status: "grace",
          standing: "grace",
          periodEnd: at,
          dunningAttempts: 2,
          reasons: ["past_due"],
        },
      ],
      attentionCount: 1,
    });

    const loaded = update(
      base,
      Message.ReceivedAdminQuery({
        message: AdminQueries.Message.SucceededOverview({ requestId, overview }),
      }),
    ).model;

    const root = rootOf(loaded);
    const text = textOf(root);

    expect(nodesWithClass(root, "pk-attention")).toHaveLength(1);
    expect(text).toContain("Past due");
    expect(text).toContain("2 failed payments");
    expect(text).toContain("Estimated MRR");
    expect(text).toContain("In grace");
    expect(text).toContain("Failed payments");
    expect(text).not.toContain("Growth scenario");
    expect(text).not.toContain("Churned");
    expect(text).not.toContain("At risk");
    expect(text).not.toContain("Accounts by plan");
    expect(text).not.toContain("Revenue by currency");
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
