import { actionsFor } from "@potion.run/paykit/Admin";
import type { Allowance } from "@potion.run/paykit/Allowance";
import type { BillingReadRow } from "@potion.run/paykit/BillingReadStore";
import type { Catalog } from "@potion.run/paykit/Catalog";
import type { Feature } from "@potion.run/paykit/Feature";
import type { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import type { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import { AccountId } from "@potion.run/paykit/Subscription/Subscription.state";
import type { Tier } from "@potion.run/paykit/Tier";
import type { TimelineEntry } from "@potion.run/paykit/Timeline";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { devToolsEvents, devToolsTabs, nextEventSeq } from "./DevTools.ts";
import { formatDateTime, formatMoney, formatOptionalDateTime } from "./format.ts";
import { Message } from "./Message.ts";
import {
  type AccountState,
  type ActionDraft,
  ConsoleAction,
  type AdminFailure,
  type Model,
  type Pending,
  type PreviewState,
} from "./Model.ts";
import { alert, alertDescription } from "./ui/alert.ts";
import { badge as uiBadge, type BadgeVariant } from "./ui/badge.ts";
import { button as uiButton, type ButtonSize, type ButtonVariant } from "./ui/button.ts";
import { card, cardDescription, cardHeader, cardTitle } from "./ui/card.ts";
import { empty } from "./ui/empty.ts";
import { field } from "./ui/field.ts";
import { input } from "./ui/input.ts";
import { select } from "./ui/select.ts";
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "./ui/table.ts";
import { tab, tabList } from "./ui/tabs.ts";
import { textarea } from "./ui/textarea.ts";

type SelectOption = { readonly value: string; readonly label: string };

type LocalButtonOptions = Readonly<{
  readonly isDisabled?: boolean;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}>;

const button = (
  label: string,
  message: Message,
  h: HtmlBuilder<Message>,
  options: LocalButtonOptions = {},
): Html =>
  uiButton(
    h,
    {
      onClick: message,
      isDisabled: options.isDisabled,
      variant: options.variant ?? "outline",
      size: options.size,
    },
    [label],
  );

type Tone = "neutral" | "success" | "warning" | "destructive" | "info";

const iconPaths = {
  accounts:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  arrowLeft: "M19 12H5 M12 19l-7-7 7-7",
  chevronRight: "m9 18 6-6-6-6",
  features: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  plans: "M12 2 2 7l10 5 10-5-10-5Z M2 17l10 5 10-5 M2 12l10 5 10-5",
} as const;

const icon = (h: HtmlBuilder<Message>, path: string, className = "pk-icon"): Html =>
  h.svg(
    [
      h.Class(className),
      h.ViewBox("0 0 24 24"),
      h.Width("16"),
      h.Height("16"),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("1.8"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
      h.AriaHidden(true),
    ],
    [h.path([h.D(path)], [])],
  );

const initialsOf = (value: string): string => {
  const trimmed = value.replace(/^acct[_-]?/i, "");
  return (trimmed === "" ? value : trimmed).slice(0, 2).toUpperCase();
};

const accountAvatar = (account: string, h: HtmlBuilder<Message>, isSmall = false): Html =>
  h.span(
    [h.Class(isSmall ? "pk-avatar pk-avatar-sm" : "pk-avatar"), h.AriaHidden(true)],
    [initialsOf(account)],
  );

const standingValueOf = (status: string): "good" | "grace" | "blocked" =>
  status === "grace" ? "grace" : status === "active" || status === "trialing" ? "good" : "blocked";

const navItem = (
  label: string,
  path: string,
  isActive: boolean,
  message: Message,
  h: HtmlBuilder<Message>,
): Html =>
  uiButton(
    h,
    {
      onClick: message,
      variant: "ghost",
      className: "pk-nav-item",
      attributes: [
        h.DataAttribute("active", isActive ? "true" : "false"),
        ...(isActive ? [h.AriaCurrent("page")] : []),
      ],
    },
    [icon(h, path, "pk-nav-icon"), h.span([h.Class("pk-nav-text")], [label])],
  );

const stat = (
  label: string,
  value: string,
  detail: string,
  tone: Tone,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("pk-stat"), h.DataAttribute("tone", tone)],
    [
      h.span([h.Class("pk-stat-label")], [label]),
      h.strong([h.Class("pk-stat-value")], [value]),
      h.span([h.Class("pk-stat-detail")], [detail]),
    ],
  );

const section = (
  title: string,
  description: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class("pk-section")],
    [
      h.div(
        [h.Class("pk-section-head")],
        [
          h.div(
            [],
            [
              h.h2([h.Class("pk-section-title")], [title]),
              h.p([h.Class("pk-section-description")], [description]),
            ],
          ),
        ],
      ),
      ...children,
    ],
  );

const sidebarView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.aside(
    [h.Class("pk-sidebar")],
    [
      h.div(
        [h.Class("pk-brand")],
        [
          h.div([h.Class("pk-brand-mark"), h.AriaHidden(true)], ["p"]),
          h.div(
            [h.Class("pk-brand-copy")],
            [
              h.span([h.Class("pk-brand-name")], ["Paykit"]),
              h.span([h.Class("pk-brand-tagline")], ["Billing operations"]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("pk-workspace")],
        [
          h.span([h.Class("pk-workspace-label")], ["Workspace"]),
          h.div(
            [h.Class("pk-workspace-name")],
            [h.span([h.Class("pk-workspace-dot")], []), h.span([], ["Admin console"])],
          ),
        ],
      ),
      h.nav(
        [h.Class("pk-nav"), h.AriaLabel("Console")],
        [
          navItem(
            "Accounts",
            iconPaths.accounts,
            model.route._tag === "Accounts" || model.route._tag === "Account",
            Message.ClosedAccount(),
            h,
          ),
          h.p([h.Class("pk-nav-label")], ["Catalog"]),
          navItem(
            "Plans",
            iconPaths.plans,
            model.route._tag === "Plans",
            Message.ClickedPlans(),
            h,
          ),
          navItem(
            "Features",
            iconPaths.features,
            model.route._tag === "Features",
            Message.ClickedFeatures(),
            h,
          ),
        ],
      ),
      h.div(
        [h.Class("pk-sidebar-footer")],
        [
          Option.match(model.actor, {
            onNone: () => h.span([h.Class("pk-user-name")], ["No actor seeded"]),
            onSome: (actor) =>
              h.div(
                [h.Class("pk-user")],
                [
                  h.span(
                    [h.Class("pk-avatar pk-avatar-user"), h.AriaHidden(true)],
                    [initialsOf(actor.id)],
                  ),
                  h.div(
                    [h.Class("pk-user-copy")],
                    [
                      h.span([h.Class("pk-user-name")], [actor.id]),
                      h.span([h.Class("pk-user-kind")], [actor.kind]),
                    ],
                  ),
                ],
              ),
          }),
        ],
      ),
    ],
  );

const breadcrumbItems = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  switch (model.route._tag) {
    case "Accounts":
      return [h.strong([], ["Accounts"])];
    case "Account":
      return [
        h.span([], ["Accounts"]),
        icon(h, iconPaths.chevronRight, "pk-crumb-icon"),
        h.strong([], [model.route.account]),
      ];
    case "Plans":
      return [h.strong([], ["Plans"])];
    case "Features":
      return [h.strong([], ["Features"])];
  }
};

const topbarView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class("pk-topbar")],
    [
      h.nav(
        [h.Class("pk-breadcrumb"), h.AriaLabel("Breadcrumb")],
        [
          h.span([], ["Billing"]),
          icon(h, iconPaths.chevronRight, "pk-crumb-icon"),
          ...breadcrumbItems(model, h),
        ],
      ),
      h.div(
        [h.Class("pk-topbar-actions")],
        [h.span([h.Class("pk-env-chip")], [h.span([h.Class("pk-env-dot")], []), "Admin console"])],
      ),
    ],
  );

const accountsPageHead = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("pk-page-head")],
    [
      h.div(
        [],
        [
          h.p([h.Class("pk-eyebrow")], ["Billing"]),
          h.h1([], ["Accounts"]),
          h.p(
            [h.Class("pk-page-subtitle")],
            ["Every account, its standing and where its period stands."],
          ),
        ],
      ),
      h.div(
        [h.Class("pk-page-actions")],
        [button("Refresh", Message.ClickedRefresh(), h, { variant: "default" })],
      ),
    ],
  );

const accountPageHead = (account: AccountState, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("pk-page-head pk-detail-page-head")],
    [
      h.div(
        [h.Class("pk-detail-heading")],
        [
          h.div(
            [h.Class("pk-back-row")],
            [
              uiButton(h, { onClick: Message.ClosedAccount(), variant: "ghost", size: "sm" }, [
                icon(h, iconPaths.arrowLeft, "pk-button-icon"),
                "All accounts",
              ]),
            ],
          ),
          h.div(
            [h.Class("pk-detail-identity")],
            [
              accountAvatar(account.id, h),
              h.div(
                [h.Class("pk-detail-copy")],
                [
                  h.p([h.Class("pk-eyebrow")], ["Account"]),
                  h.div([h.Class("pk-detail-title-row")], [h.h1([], [account.id])]),
                ],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("pk-page-actions")],
        [
          badge("feed", account.feed, h),
          button("Refresh", Message.ClickedRefresh(), h, { variant: "default" }),
        ],
      ),
    ],
  );

const catalogPageHead = (title: string, subtitle: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("pk-page-head")],
    [
      h.div(
        [],
        [
          h.p([h.Class("pk-eyebrow")], ["Catalog"]),
          h.h1([], [title]),
          h.p([h.Class("pk-page-subtitle")], [subtitle]),
        ],
      ),
      h.div([h.Class("pk-page-actions")], [h.span([h.Class("pk-count-pill")], ["Read only"])]),
    ],
  );

const pageHeadView = (model: Model, h: HtmlBuilder<Message>): Html => {
  switch (model.route._tag) {
    case "Account":
      return Option.match(model.account, {
        onNone: () => accountsPageHead(h),
        onSome: (account) => accountPageHead(account, h),
      });
    case "Accounts":
      return accountsPageHead(h);
    case "Plans":
      return catalogPageHead(
        "Plans",
        "The tiers this deployment sells, what they include, and what they cost.",
        h,
      );
    case "Features":
      return catalogPageHead(
        "Features",
        "Every feature the deployment declares and how it is metered.",
        h,
      );
  }
};

const badgeVariantOf = (kind: string, value: string): BadgeVariant => {
  if (kind === "standing") {
    return value === "good" ? "success" : value === "grace" ? "warning" : "destructive";
  }
  if (kind === "status") {
    return value === "active" || value === "trialing"
      ? "success"
      : value === "grace"
        ? "warning"
        : "destructive";
  }
  if (kind === "feed") {
    return value === "Live" ? "success" : value === "CatchingUp" ? "warning" : "destructive";
  }
  if (kind === "pending") {
    return value === "Accepted"
      ? "success"
      : value === "Sending"
        ? "info"
        : value === "Unknown"
          ? "warning"
          : "destructive";
  }
  if (kind === "holds") {
    return Number(value) === 0 ? "secondary" : "info";
  }
  return "secondary";
};

const badge = (kind: string, value: string, h: HtmlBuilder<Message>) =>
  uiBadge(
    h,
    {
      variant: badgeVariantOf(kind, value),
      className: `pk-badge-${kind}`,
      attributes: [h.DataAttribute(`paykit-${kind}`, value)],
    },
    [value],
  );

const textField = (
  id: string,
  label: string,
  value: string,
  onInput: (value: string) => Message,
  h: HtmlBuilder<Message>,
  type = "text",
): Html =>
  field(h, { id, label }, [
    input(h, {
      id,
      value,
      onInput,
      type,
      attributes: type === "number" ? [h.Min("1"), h.Step("1")] : [],
    }),
  ]);

const textAreaField = (
  id: string,
  label: string,
  value: string,
  onInput: (value: string) => Message,
  h: HtmlBuilder<Message>,
  rows = 6,
): Html => field(h, { id, label }, [textarea(h, { id, value, onInput, rows })]);

const selectField = (
  id: string,
  label: string,
  value: string,
  options: ReadonlyArray<SelectOption>,
  onChange: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html => field(h, { id, label }, [select(h, { id, value, options, onChange })]);

const selectControl = (
  id: string,
  label: string,
  value: string,
  options: ReadonlyArray<SelectOption>,
  onChange: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html => select(h, { id, value, options, onChange, ariaLabel: label });

const filterOptions = (
  values: ReadonlyArray<string>,
  allLabel: string,
): ReadonlyArray<{ readonly value: string; readonly label: string }> => [
  { value: "", label: allLabel },
  ...values.map((value) => ({ value, label: value })),
];

const accountsSummaryView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const rows = model.accounts.rows;
  const countOf = (standing: string): number =>
    rows.filter((row) => row.standing === standing).length;
  return h.div(
    [
      h.Class("pk-stats"),
      h.DataAttribute("paykit-summary", "accounts"),
      h.AriaLabel("Accounts on this page"),
    ],
    [
      stat("Accounts", String(rows.length), "On this page", "neutral", h),
      stat("Good standing", String(countOf("good")), "Active or trialing", "success", h),
      stat("In grace", String(countOf("grace")), "Payment attention", "warning", h),
      stat("Blocked", String(countOf("blocked")), "Access suspended", "destructive", h),
    ],
  );
};

const accountsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const filter = model.accounts.filter;
  const standing = Option.getOrElse(filter.standing, () => "");
  const status = Option.getOrElse(filter.status, () => "");
  const tier = Option.getOrElse(filter.tier, () => "");
  const hasFilter =
    Option.isSome(filter.standing) || Option.isSome(filter.status) || Option.isSome(filter.tier);
  // A list is a point-in-time read, never a live view: say when it was read,
  // or say the read time is unknown. The panel never presents the rows as
  // current, because the account it opens is live and this is not.
  const asOf = Option.getOrUndefined(model.accounts.asOf);
  const asOfText =
    asOf === undefined
      ? `Snapshot · read time unknown${model.accounts.state === "Loading" ? " · refreshing…" : ""}`
      : `Read ${formatDateTime(asOf)} · not live${model.accounts.state === "Loading" ? " · refreshing…" : ""}`;
  const tierOptions = Option.match(model.catalog, {
    onNone: () => [{ value: "", label: "All tiers" }],
    onSome: (catalog: Catalog) =>
      filterOptions(
        catalog.tiers.map((entry) => entry.id),
        "All tiers",
      ),
  });

  return h.div(
    [h.Class("pk-accounts-page")],
    [
      accountsSummaryView(model, h),
      card(
        h,
        [
          cardHeader(h, [
            h.div(
              [],
              [
                cardTitle(h, ["Accounts"]),
                cardDescription(h, ["Every account with its plan, standing and current period."]),
                h.p(
                  [
                    h.Class("pk-as-of"),
                    h.DataAttribute(
                      "paykit-as-of",
                      asOf === undefined ? "unknown" : DateTime.formatIso(asOf),
                    ),
                  ],
                  [asOfText],
                ),
              ],
            ),
            h.div(
              [h.Class("pk-card-actions")],
              [
                h.span(
                  [h.Class("pk-count-pill")],
                  [
                    `${model.accounts.rows.length} ${
                      model.accounts.rows.length === 1 ? "account" : "accounts"
                    }`,
                  ],
                ),
              ],
            ),
          ]),
          h.div(
            [h.Class("pk-filters")],
            [
              selectControl(
                "filter-standing",
                "Standing",
                standing,
                filterOptions(["good", "grace", "blocked"], "All standings"),
                (value) => Message.UpdatedStandingFilter({ value }),
                h,
              ),
              selectControl(
                "filter-status",
                "Status",
                status,
                filterOptions(
                  ["trialing", "active", "grace", "canceled", "expired"],
                  "All statuses",
                ),
                (value) => Message.UpdatedStatusFilter({ value }),
                h,
              ),
              selectControl(
                "filter-tier",
                "Tier",
                tier,
                tierOptions,
                (value) => Message.UpdatedTierFilter({ value }),
                h,
              ),
            ],
          ),
          Option.match(model.accounts.error, {
            onNone: () => h.empty,
            onSome: (error) =>
              alert(h, { variant: "destructive" }, [
                alertDescription(h, [`Could not load accounts: ${error}`]),
              ]),
          }),
          model.accounts.rows.length === 0
            ? model.accounts.state === "Loading"
              ? h.p([h.Class("pk-muted pk-loading")], ["Loading accounts…"])
              : empty(h, {
                  title: hasFilter
                    ? "No accounts match these filters."
                    : "No accounts on this page.",
                  description: hasFilter
                    ? "Adjust the filters or refresh the list."
                    : "Accounts appear here after their first billing event reaches the projection.",
                })
            : table(
                h,
                [
                  tableHeader(h, [
                    tableRow(h, [
                      tableHead(h, ["Account"]),
                      tableHead(h, ["Plan"]),
                      tableHead(h, ["Status"]),
                      tableHead(h, ["Standing"]),
                      tableHead(h, ["Period end"]),
                      tableHead(h, [h.span([h.Class("pk-sr-only")], ["Open account"])]),
                    ]),
                  ]),
                  tableBody(
                    h,
                    model.accounts.rows.map((row: BillingReadRow) =>
                      tableRow(
                        h,
                        [
                          tableCell(
                            h,
                            [
                              h.div(
                                [h.Class("pk-account-cell")],
                                [
                                  accountAvatar(row.account, h, true),
                                  h.div(
                                    [h.Class("pk-account-copy")],
                                    [
                                      h.span([h.Class("pk-account-name")], [row.account]),
                                      h.span(
                                        [h.Class("pk-account-meta")],
                                        [
                                          `${formatMoney(row.credits, row.currency)}${
                                            row.cancelAtPeriodEnd ? " · cancels" : ""
                                          }`,
                                        ],
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ],
                            { className: "pk-account-id" },
                          ),
                          tableCell(h, [h.span([h.Class("pk-plan-name")], [row.tier])]),
                          tableCell(h, [badge("status", row.status, h)]),
                          tableCell(h, [badge("standing", row.standing, h)]),
                          tableCell(h, [formatDateTime(row.periodEnd)]),
                          tableCell(h, [icon(h, iconPaths.chevronRight)], {
                            className: "pk-row-arrow",
                          }),
                        ],
                        {
                          key: row.account,
                          className: "pk-row",
                          attributes: [
                            h.OnClick(
                              Message.ClickedAccount({ account: AccountId.make(row.account) }),
                            ),
                          ],
                        },
                      ),
                    ),
                  ),
                ],
                { ariaLabel: "Accounts" },
              ),
          h.div(
            [h.Class("pk-table-footer")],
            [
              h.span(
                [h.Class("pk-muted")],
                [
                  Option.isSome(model.accounts.next)
                    ? "More accounts match these filters."
                    : "End of the current page.",
                ],
              ),
              Option.match(model.accounts.next, {
                onNone: () => h.empty,
                onSome: () => button("Next page", Message.ClickedNextPage(), h),
              }),
            ],
          ),
        ],
        {
          className: "pk-accounts",
          attributes: [h.DataAttribute("paykit-consistency", "snapshot")],
        },
      ),
    ],
  );
};

const catalogBadge = (label: string, variant: BadgeVariant, h: HtmlBuilder<Message>): Html =>
  uiBadge(h, { variant, className: "pk-badge-catalog" }, [label]);

const catalogFeature = (catalog: Catalog, id: string, h: HtmlBuilder<Message>): Html => {
  const feature = catalog.features.find((candidate) => candidate.id === id);
  return h.div(
    [h.Class("pk-catalog-feature")],
    [
      h.span([h.Class("pk-catalog-feature-name")], [feature?.name ?? id]),
      ...(feature?.name === undefined ? [] : [h.span([h.Class("pk-catalog-feature-id")], [id])]),
    ],
  );
};

const includedLabel = (allowance: Allowance): string =>
  allowance.kind === "flag"
    ? "On / off"
    : allowance.included === "unlimited"
      ? "Unlimited"
      : String(allowance.included);

const allowanceTerms = (allowance: Allowance): string => {
  if (allowance.kind === "flag") return "—";
  const terms: string[] = [];
  if (allowance.carryOver === true) terms.push("carry over");
  if (allowance.cap !== undefined) terms.push(`${allowance.cap} unit cap`);
  if (allowance.unitPrice !== undefined)
    terms.push(`${formatMoney(allowance.unitPrice.amount, allowance.unitPrice.currency)} / unit`);
  if (allowance.moneyCap !== undefined)
    terms.push(`${formatMoney(allowance.moneyCap, allowance.unitPrice?.currency)} money cap`);
  return terms.length === 0 ? "—" : terms.join(" · ");
};

const tierKindOf = (tier: Tier): "subscription" | "one_off" => tier.kind ?? "subscription";

const planGrants = (catalog: Catalog, tier: Tier, h: HtmlBuilder<Message>): Html =>
  tier.grants.length === 0
    ? h.p([h.Class("pk-muted")], ["This pack sells credits only."])
    : table(
        h,
        [
          tableHeader(h, [
            tableRow(h, [
              tableHead(h, ["Feature"]),
              tableHead(h, ["Included"]),
              tableHead(h, ["Overage"]),
              tableHead(h, ["Resets"]),
              tableHead(h, ["Terms"]),
            ]),
          ]),
          tableBody(
            h,
            tier.grants.map((allowance) =>
              tableRow(
                h,
                [
                  tableCell(h, [catalogFeature(catalog, allowance.feature, h)]),
                  tableCell(h, [includedLabel(allowance)]),
                  tableCell(h, [allowance.overage]),
                  tableCell(h, [allowance.resets]),
                  tableCell(h, [allowanceTerms(allowance)]),
                ],
                { key: allowance.feature },
              ),
            ),
          ),
        ],
        { ariaLabel: `${tier.name ?? tier.id} grants` },
      );

const planCard = (catalog: Catalog, tier: Tier, h: HtmlBuilder<Message>): Html => {
  const kind = tierKindOf(tier);
  const price =
    tier.price === undefined
      ? "Free"
      : `${formatMoney(tier.price.amount, tier.price.currency)} / ${tier.price.interval}`;
  const creditsExpire = tier.creditsExpire ?? (kind === "one_off" ? "never" : "period");
  return card(
    h,
    [
      h.div(
        [h.Class("pk-plan-head")],
        [
          h.div(
            [],
            [
              h.h2([h.Class("pk-plan-name")], [tier.name ?? tier.id]),
              h.span([h.Class("pk-plan-id")], [tier.id]),
            ],
          ),
          h.span([h.Class("pk-plan-price")], [price]),
        ],
      ),
      h.div(
        [h.Class("pk-plan-badges")],
        [
          catalogBadge(
            kind === "one_off" ? "One-off pack" : "Subscription",
            kind === "one_off" ? "info" : "outline",
            h,
          ),
          ...(tier.credits === undefined
            ? []
            : [catalogBadge(`${tier.credits.toLocaleString("en")} credits`, "secondary", h)]),
        ],
      ),
      h.div(
        [h.Class("pk-plan-meta")],
        [
          h.span(
            [],
            [
              h.strong([], [String(tier.grants.length)]),
              ` ${tier.grants.length === 1 ? "grant" : "grants"}`,
            ],
          ),
          ...(tier.credits === undefined
            ? []
            : [
                h.span(
                  [],
                  [
                    `Credits ${creditsExpire === "never" ? "never expire" : "expire at period end"}`,
                  ],
                ),
              ]),
        ],
      ),
      h.div(
        [h.Class("pk-plan-grants")],
        [h.h3([h.Class("pk-plan-grants-title")], ["Grants"]), planGrants(catalog, tier, h)],
      ),
    ],
    {
      className: "pk-plan-card",
      attributes: [
        h.DataAttribute("paykit-plan", tier.id),
        h.DataAttribute("paykit-plan-kind", kind),
      ],
    },
  );
};

const catalogStats = (
  values: ReadonlyArray<readonly [string, string, string, Tone]>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("pk-stats")],
    values.map(([label, value, detail, tone]) => stat(label, value, detail, tone, h)),
  );

const catalogUnavailableView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("pk-catalog-page")],
    [
      empty(h, {
        title: Option.isSome(model.catalogError) ? "Catalog unavailable." : "Loading the catalog…",
        description: Option.match(model.catalogError, {
          onNone: () => "The deploy catalog is on its way.",
          onSome: (error) => `The deploy did not answer with a catalog: ${error}.`,
        }),
      }),
    ],
  );

const plansView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const catalog = Option.getOrNull(model.catalog);
  if (catalog === null) return catalogUnavailableView(model, h);
  const tiers = catalog.tiers;
  const subscriptions = tiers.filter((tier) => tierKindOf(tier) === "subscription").length;
  const oneOff = tiers.length - subscriptions;
  const priced = tiers.filter((tier) => tier.price !== undefined).length;
  return h.div(
    [h.Class("pk-catalog-page"), h.DataAttribute("paykit-catalog", "plans")],
    [
      catalogStats(
        [
          ["Plans", String(tiers.length), "In this deploy", "neutral"],
          ["Subscriptions", String(subscriptions), "Recurring standing", "info"],
          ["One-off packs", String(oneOff), "Credits only", "info"],
          ["Priced", String(priced), "With a price", "success"],
        ],
        h,
      ),
      tiers.length === 0
        ? empty(h, {
            title: "No plans declared.",
            description: "The deploy's catalog has no tiers.",
          })
        : h.div(
            [h.Class("pk-plan-grid")],
            tiers.map((tier) => planCard(catalog, tier, h)),
          ),
    ],
  );
};

const creditRatesLabel = (feature: Feature): string =>
  feature.creditRates === undefined
    ? "—"
    : Object.entries(feature.creditRates)
        .map(([dimension, credits]) => `${dimension}: ${credits}`)
        .join(" · ");

const grantedBy = (catalog: Catalog, feature: Feature, h: HtmlBuilder<Message>): Html => {
  const tiers = catalog.tiers.filter((tier) =>
    tier.grants.some((allowance) => allowance.feature === feature.id),
  );
  return tiers.length === 0
    ? h.span([h.Class("pk-muted")], ["Not granted"])
    : h.div(
        [h.Class("pk-plan-tag-list")],
        tiers.map((tier) =>
          h.span(
            [h.Class("pk-plan-tag"), h.DataAttribute("paykit-plan-tag", tier.id)],
            [tier.name ?? tier.id],
          ),
        ),
      );
};

const featuresView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const catalog = Option.getOrNull(model.catalog);
  if (catalog === null) return catalogUnavailableView(model, h);
  const features = catalog.features;
  const flags = features.filter((feature) => feature.kind === "flag").length;
  const metered = features.length - flags;
  const creditPriced = features.filter((feature) => feature.creditRates !== undefined).length;
  return h.div(
    [h.Class("pk-catalog-page"), h.DataAttribute("paykit-catalog", "features")],
    [
      catalogStats(
        [
          ["Features", String(features.length), "In this deploy", "neutral"],
          ["Metered", String(metered), "Counted usage", "info"],
          ["Flags", String(flags), "On or off", "info"],
          ["Credit priced", String(creditPriced), "With a rate card", "success"],
        ],
        h,
      ),
      card(
        h,
        [
          cardHeader(h, [
            h.div(
              [],
              [
                cardTitle(h, ["Features"]),
                cardDescription(h, [
                  "Every capability a plan can grant, and the plans that grant it.",
                ]),
              ],
            ),
            h.span(
              [h.Class("pk-count-pill")],
              [`${features.length} ${features.length === 1 ? "feature" : "features"}`],
            ),
          ]),
          features.length === 0
            ? empty(h, {
                title: "No features declared.",
                description: "The deploy's catalog has no features.",
              })
            : table(
                h,
                [
                  tableHeader(h, [
                    tableRow(h, [
                      tableHead(h, ["Feature"]),
                      tableHead(h, ["Kind"]),
                      tableHead(h, ["Credit rates"]),
                      tableHead(h, ["Granted by"]),
                    ]),
                  ]),
                  tableBody(
                    h,
                    features.map((feature) =>
                      tableRow(
                        h,
                        [
                          tableCell(h, [catalogFeature(catalog, feature.id, h)]),
                          tableCell(h, [
                            catalogBadge(
                              feature.kind === "flag" ? "Flag" : "Metered",
                              feature.kind === "flag" ? "secondary" : "outline",
                              h,
                            ),
                          ]),
                          tableCell(h, [creditRatesLabel(feature)]),
                          tableCell(h, [grantedBy(catalog, feature, h)]),
                        ],
                        { key: feature.id },
                      ),
                    ),
                  ),
                ],
                { ariaLabel: "Features" },
              ),
        ],
        { className: "pk-features" },
      ),
    ],
  );
};

const billingView = (billing: BillingStateView, h: HtmlBuilder<Message>): Html =>
  card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Plan & billing"]),
            cardDescription(h, ["The standing this account is billed on."]),
          ],
        ),
        h.div(
          [h.Class("pk-badges")],
          [
            badge("status", billing.status, h),
            badge("standing", standingValueOf(billing.status), h),
          ],
        ),
      ]),
      h.dl(
        [h.Class("pk-facts")],
        [
          h.div([], [h.dt([], ["Tier"]), h.dd([], [billing.tier])]),
          h.div(
            [],
            [
              h.dt([], ["Period"]),
              h.dd(
                [],
                [`${formatDateTime(billing.periodStart)} – ${formatDateTime(billing.periodEnd)}`],
              ),
            ],
          ),
          h.div([], [h.dt([], ["Interval"]), h.dd([], [billing.interval])]),
          h.div(
            [],
            [
              h.dt([], ["Price"]),
              h.dd(
                [],
                [
                  billing.price === undefined
                    ? "Free"
                    : `${formatMoney(billing.price.amount, billing.price.currency)} / ${billing.price.interval}`,
                ],
              ),
            ],
          ),
          h.div(
            [],
            [h.dt([], ["Credits"]), h.dd([], [formatMoney(billing.credits, billing.currency)])],
          ),
          h.div(
            [],
            [h.dt([], ["Trial ends"]), h.dd([], [formatOptionalDateTime(billing.trialEndsAt)])],
          ),
          h.div(
            [],
            [h.dt([], ["Grace until"]), h.dd([], [formatOptionalDateTime(billing.graceUntil)])],
          ),
          h.div(
            [],
            [
              h.dt([], ["Cancel at period end"]),
              h.dd([], [billing.cancelAtPeriodEnd ? "Yes" : "No"]),
            ],
          ),
        ],
      ),
    ],
    { className: "pk-billing" },
  );

const featureTable = (entitlements: EntitlementsState, h: HtmlBuilder<Message>): Html => {
  const entries = Object.entries(entitlements.features);
  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Allowances"]),
            cardDescription(h, ["What this standing includes, and what is left to use."]),
          ],
        ),
        badge("holds", String(entries.length), h),
      ]),
      entries.length === 0
        ? empty(h, {
            title: "No allowances yet.",
            description: "This account has no features from its standing.",
          })
        : table(
            h,
            [
              tableHeader(h, [
                tableRow(h, [
                  tableHead(h, ["Feature"]),
                  tableHead(h, ["Included"]),
                  tableHead(h, ["Used"]),
                  tableHead(h, ["Reserved"]),
                  tableHead(h, ["Remaining"]),
                  tableHead(h, ["Overage"]),
                  tableHead(h, ["Resets"]),
                ]),
              ]),
              tableBody(
                h,
                entries.map(([name, feature]) =>
                  tableRow(
                    h,
                    [
                      tableCell(h, [name]),
                      tableCell(h, [String(feature.included)]),
                      tableCell(h, [String(feature.used)]),
                      tableCell(h, [String(feature.reserved)]),
                      tableCell(h, [String(feature.remaining)]),
                      tableCell(h, [feature.overage]),
                      tableCell(h, [feature.resets]),
                    ],
                    { key: name },
                  ),
                ),
              ),
            ],
            { ariaLabel: "Allowances" },
          ),
    ],
    { className: "pk-allowances" },
  );
};

/** A point-in-time read's label: never claims to be live. */
const readLabel = (asOf: Option.Option<DateTime.Utc>, loading: boolean, live = false): string => {
  if (loading) return "Refreshing…";
  const value = Option.getOrUndefined(asOf);
  if (value === undefined) return "Snapshot · read time unknown";
  return `Read ${formatDateTime(value)} · ${live ? "live reads follow" : "not live"}`;
};

/**
 * The holds the allowance table folded into `reserved` counts. A hold is an
 * entity with a deadline, and the operator's question is which ones are still
 * waiting.
 */
const holdsView = (account: AccountState, h: HtmlBuilder<Message>): Html => {
  if (Option.isNone(account.holds)) return h.empty;
  const holds = account.holds.value;
  const open = holds.holds.filter((hold) => hold.status === "open");
  const asOf = Option.getOrUndefined(holds.asOf);
  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Open holds"]),
            cardDescription(h, ["Reservations the allowance table folds into reserved counts."]),
            h.p(
              [
                h.Class("pk-as-of"),
                h.DataAttribute(
                  "paykit-as-of",
                  asOf === undefined ? "unknown" : DateTime.formatIso(asOf),
                ),
              ],
              [readLabel(holds.asOf, holds.state === "Loading", true)],
            ),
          ],
        ),
        badge("holds", String(open.length), h),
      ]),
      Option.match(holds.error, {
        onNone: () => h.empty,
        onSome: (error) =>
          alert(h, { variant: "destructive" }, [
            alertDescription(h, [`Could not load holds: ${error}`]),
          ]),
      }),
      open.length === 0
        ? empty(h, {
            title: "No open holds.",
            description:
              "A hold appears from the moment it is taken until it settles or is released.",
          })
        : table(
            h,
            [
              tableHeader(h, [
                tableRow(h, [
                  tableHead(h, ["Hold"]),
                  tableHead(h, ["Feature"]),
                  tableHead(h, ["Amount"]),
                  tableHead(h, ["Credits"]),
                  tableHead(h, ["Held at"]),
                  tableHead(h, ["Expires"]),
                ]),
              ]),
              tableBody(
                h,
                open.map((hold) =>
                  tableRow(
                    h,
                    [
                      tableCell(h, [hold.id], { className: "pk-account-id" }),
                      tableCell(h, [hold.feature]),
                      tableCell(h, [String(hold.amount)]),
                      tableCell(h, [hold.cost === 0 ? "—" : `${hold.cost} credits`]),
                      tableCell(h, [formatDateTime(hold.at)]),
                      tableCell(h, [formatDateTime(hold.expiresAt)]),
                    ],
                    { key: hold.id },
                  ),
                ),
              ),
            ],
            { ariaLabel: "Open holds" },
          ),
    ],
    { className: "pk-holds", attributes: [h.DataAttribute("paykit-holds", String(open.length))] },
  );
};

/**
 * What this period recorded at each price, and what it billed. The allowance
 * table says what is left; this says what the period has cost so far.
 */
const usageView = (entitlements: EntitlementsState, h: HtmlBuilder<Message>): Html => {
  const rows = Object.entries(entitlements.features).flatMap(([feature, entry]) => {
    const priced = Object.values(entry.priced ?? {});
    return priced.length === 0 && entry.billed === undefined ? [] : [{ feature, entry, priced }];
  });
  if (rows.length === 0) return h.empty;
  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Usage this period"]),
            cardDescription(h, ["What the period recorded at each price, and what it billed."]),
          ],
        ),
      ]),
      table(
        h,
        [
          tableHeader(h, [
            tableRow(h, [
              tableHead(h, ["Feature"]),
              tableHead(h, ["Recorded at"]),
              tableHead(h, ["Billed"]),
              tableHead(h, ["Ceiling"]),
            ]),
          ]),
          tableBody(
            h,
            rows.map(({ feature, entry, priced }) =>
              tableRow(
                h,
                [
                  tableCell(h, [feature]),
                  tableCell(h, [
                    priced.length === 0
                      ? "—"
                      : priced
                          .map(
                            (units) =>
                              `${units.quantity} @ ${formatMoney(units.unitPrice.amount, units.unitPrice.currency)}`,
                          )
                          .join(" · "),
                  ]),
                  tableCell(h, [
                    entry.billed === undefined
                      ? "—"
                      : formatMoney(entry.billed, entitlements.currency),
                  ]),
                  tableCell(h, [
                    [
                      entry.cap === undefined ? null : `${entry.cap} units`,
                      entry.moneyCap === undefined
                        ? null
                        : formatMoney(entry.moneyCap, entitlements.currency),
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" / ") || "—",
                  ]),
                ],
                { key: feature },
              ),
            ),
          ),
        ],
        { ariaLabel: "Usage this period" },
      ),
    ],
    { className: "pk-usage" },
  );
};

const previewAnswerView = (preview: PreviewState, h: HtmlBuilder<Message>): Html => {
  if (preview.state === "Loading") return h.p([h.Class("pk-muted")], ["Asking the model…"]);
  if (Option.isSome(preview.error)) {
    return alert(h, { variant: "destructive" }, [
      alertDescription(h, [`Preview failed: ${preview.error.value}`]),
    ]);
  }
  if (Option.isNone(preview.answer)) return h.empty;
  return Match.value(preview.answer.value).pipe(
    Match.withReturnType<Html>(),
    Match.tag("accepted", ({ state, events, proration }) =>
      h.div(
        [h.Class("pk-verdict pk-verdict-accepted")],
        [
          h.p([h.Class("pk-muted")], ["Accepted. The model would record:"]),
          h.ul(
            [h.Class("pk-events")],
            events.map((event) =>
              h.keyed("li")(event._tag, [h.Class("pk-event")], [h.code([], [event._tag])]),
            ),
          ),
          ...(proration === undefined ? [] : [prorationPanel(proration, h)]),
          h.p(
            [h.Class("pk-muted")],
            [
              state._tag === "Subscribed"
                ? `Result: ${state.status} on ${state.tier}`
                : "Result: no standing",
            ],
          ),
        ],
      ),
    ),
    Match.tag("rejected", ({ rejection }) =>
      alert(h, { variant: "destructive" }, [
        alertDescription(h, [`Rejected: ${rejection._tag}`]),
        h.pre([h.Class("pk-failure")], [JSON.stringify(rejection, null, 2)]),
      ]),
    ),
    Match.tag("unpredictable", ({ reason }) =>
      h.p([h.Class("pk-muted")], [`Only the server can decide this one: ${reason}`]),
    ),
    Match.exhaustive,
  );
};

/**
 * Ask `decide` what it would do, without recording anything. This is the
 * console's answer to "why is this account on pro": the events a command would
 * write, or the rejection that keeps it from writing.
 */
const previewView = (model: Model, account: AccountState, h: HtmlBuilder<Message>): Html => {
  const tiers = Option.match(model.catalog, {
    onNone: () => [] as ReadonlyArray<string>,
    onSome: (catalog) => catalog.tiers.map((entry) => entry.id),
  });
  const tier = Option.getOrElse(account.previewTier, () => "");
  const options = [
    { value: "", label: "Choose a tier" },
    ...tiers.map((value) => ({ value, label: value })),
  ];
  const preview = Option.getOrUndefined(account.preview);
  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Ask the model"]),
            h.p(
              [h.Class("pk-muted")],
              ["Runs the same decision the write runs, and records nothing."],
            ),
          ],
        ),
        preview === undefined
          ? h.empty
          : button("Dismiss", Message.DismissedPreview(), h, { variant: "ghost" }),
      ]),
      selectField(
        "preview-tier",
        "Tier",
        tier,
        options,
        (value) => Message.UpdatedPreviewTier({ value }),
        h,
      ),
      h.div(
        [h.Class("pk-actions")],
        [
          ...(tier === ""
            ? []
            : [
                button(
                  "Preview tier change",
                  Message.ClickedPreview({ command: { kind: "changeTier", tier } }),
                  h,
                ),
                button(
                  "Preview subscribe",
                  Message.ClickedPreview({ command: { kind: "subscribe", tier } }),
                  h,
                ),
              ]),
          button(
            "Preview cancellation",
            Message.ClickedPreview({ command: { kind: "cancel" } }),
            h,
          ),
        ],
      ),
      tier === "" && preview === undefined
        ? h.p([h.Class("pk-muted")], ["Pick a tier to preview a change or a subscribe."])
        : h.empty,
      preview === undefined ? h.empty : previewAnswerView(preview, h),
    ],
    { className: "pk-preview" },
  );
};

/** Judge the standing against the deploy: catalog, prices and provider refs. */
const verifyView = (account: AccountState, h: HtmlBuilder<Message>): Html =>
  card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Verify"]),
            h.p(
              [h.Class("pk-muted")],
              ["Checks this standing against the catalog and provider the deploy runs."],
            ),
          ],
        ),
        button("Verify", Message.ClickedVerify(), h, { variant: "default" }),
      ]),
      Option.match(account.verify, {
        onNone: () => h.empty,
        onSome: (verify) =>
          verify.state === "Loading"
            ? h.p([h.Class("pk-muted")], ["Verifying…"])
            : Option.isSome(verify.error)
              ? alert(h, { variant: "destructive" }, [
                  alertDescription(h, [`Verify failed: ${verify.error.value}`]),
                ])
              : verify.mismatches.length === 0
                ? alert(h, { variant: "success" }, [
                    alertDescription(h, ["No drift: the catalog and provider agree."]),
                  ])
                : h.ul(
                    [h.Class("pk-events")],
                    verify.mismatches.map((mismatch) =>
                      h.keyed("li")(
                        `${mismatch._tag}:${JSON.stringify(mismatch)}`,
                        [h.Class("pk-failure")],
                        [
                          h.code([], [mismatch._tag]),
                          h.pre([], [JSON.stringify(mismatch, null, 2)]),
                          mismatch._tag === "MissingProviderRef" ||
                          mismatch._tag === "TierHasNoPurchasePath"
                            ? h.p(
                                [h.Class("pk-muted")],
                                ["The money path never completed; check this account's checkout."],
                              )
                            : h.p(
                                [h.Class("pk-muted")],
                                ["A vendor reference outlived the standing it described."],
                              ),
                        ],
                      ),
                    ),
                  ),
      }),
    ],
    { className: "pk-verify" },
  );

const actionButtons = (
  account: AccountState,
  catalog: Option.Option<Catalog>,
  h: HtmlBuilder<Message>,
): Html => {
  if (Option.isNone(account.billing))
    return h.p([h.Class("pk-muted")], ["Waiting for the billing snapshot."]);
  const descriptors = actionsFor(account.billing.value, {
    catalog: Option.getOrUndefined(catalog),
    entitlements: Option.getOrUndefined(account.entitlements),
  });
  const enabled = descriptors.filter((descriptor) => ConsoleAction.includes(descriptor.action));

  return card(h, [
    cardHeader(h, [
      h.div(
        [],
        [
          cardTitle(h, ["Operator actions"]),
          cardDescription(h, ["Every action is a command recorded against this account."]),
        ],
      ),
    ]),
    enabled.length === 0
      ? empty(h, {
          title: "No operator actions.",
          description: "This standing offers no action the console can send.",
        })
      : h.div(
          [h.Class("pk-actions")],
          enabled.map((descriptor) =>
            button(descriptor.action, Message.ClickedAction({ action: descriptor.action }), h),
          ),
        ),
  ]);
};

const prorationPanel = (
  proration: {
    readonly currency: string;
    readonly credit: number;
    readonly charge: number;
    readonly due: number;
  } | null,
  h: HtmlBuilder<Message>,
): Html =>
  proration === null
    ? h.p([h.Class("pk-muted")], ["No charge for this change."])
    : h.div(
        [h.Class("pk-quote")],
        [
          h.span([], [`Credit ${formatMoney(proration.credit, proration.currency)}`]),
          h.span([], [`Charge ${formatMoney(proration.charge, proration.currency)}`]),
          h.strong([], [`Due ${formatMoney(proration.due, proration.currency)}`]),
        ],
      );

const draftView = (
  model: Model,
  account: AccountState,
  draft: ActionDraft,
  h: HtmlBuilder<Message>,
): Html => {
  const updated = (field: string) => (value: string) => Message.UpdatedDraftField({ field, value });
  const changeQuote =
    draft.kind === "ChangeTier"
      ? Option.match(account.change, {
          onNone: () => Option.none(),
          onSome: (value) =>
            value.tier === draft.tier && value._tag !== "Quoting"
              ? Option.some(value)
              : Option.none(),
        })
      : Option.none();
  const isQuoted = Option.match(changeQuote, {
    onNone: () => false,
    onSome: (value) => value._tag === "Quoted",
  });
  const isApplying = Option.match(changeQuote, {
    onNone: () => false,
    onSome: (value) => value._tag === "Applying",
  });

  const controls = (): ReadonlyArray<Html> => {
    switch (draft.kind) {
      case "GrantCredits":
        return [
          textField(
            "draft-amount",
            "Amount (minor units)",
            draft.amount,
            updated("amount"),
            h,
            "number",
          ),
        ];
      case "ExtendTrial":
        return [
          textField(
            "draft-trial-ends",
            "Trial ends",
            draft.trialEndsAt,
            updated("trialEndsAt"),
            h,
            "datetime-local",
          ),
        ];
      case "EnterGrace":
        return [
          textField(
            "draft-grace-until",
            "Grace deadline",
            draft.graceUntil,
            updated("graceUntil"),
            h,
            "datetime-local",
          ),
        ];
      case "RecordPayment":
        return [
          textField(
            "draft-amount",
            "Amount (minor units)",
            draft.amount,
            updated("amount"),
            h,
            "number",
          ),
          textField("draft-currency", "Currency", draft.currency, updated("currency"), h),
        ];
      case "RecordPaymentFailure":
        return [
          textField("draft-reason", "Reason", draft.reason, updated("reason"), h),
          textField(
            "draft-grace-until",
            "Grace deadline",
            draft.graceUntil,
            updated("graceUntil"),
            h,
            "datetime-local",
          ),
        ];
      case "Recover":
      case "Expire":
      case "ScheduleCancellation":
      case "Resume":
      case "WithdrawTierChange":
        return [h.p([h.Class("pk-muted")], [`Send ${draft.kind} for this account?`])];
      case "ChangeTier":
      case "ScheduleTierChange": {
        const currentTier = Option.match(account.billing, {
          onNone: () => undefined,
          onSome: (billing) => billing.tier,
        });
        const options = Option.match(model.catalog, {
          onNone: () => [],
          onSome: (catalog) =>
            catalog.tiers
              .filter((tier) => tier.id !== currentTier)
              .map((tier) => ({
                value: tier.id,
                label: tier.name === undefined ? tier.id : `${tier.name} (${tier.id})`,
              })),
        });
        return [
          selectField("draft-tier", "New tier", draft.tier, options, updated("tier"), h),
          ...Option.match(changeQuote, {
            onNone: () => [],
            onSome: (quote) => [prorationPanel(quote.proration, h)],
          }),
        ];
      }
    }
  };

  return card(
    h,
    [
      cardHeader(h, [cardTitle(h, [draft.kind])]),
      ...controls(),
      h.div(
        [h.Class("pk-actions")],
        [
          ...(isQuoted
            ? [
                button("Confirm charge", Message.ClickedConfirmChangeTier(), h, {
                  variant: "default",
                }),
              ]
            : isApplying
              ? [h.span([h.Class("pk-muted")], ["Applying…"])]
              : [
                  button(
                    draft.kind === "ChangeTier" ? "Quote change" : "Send command",
                    Message.ClickedSubmitAction(),
                    h,
                    { variant: "default" },
                  ),
                ]),
          button("Cancel", Message.ClickedCancelAction(), h, { variant: "ghost" }),
        ],
      ),
    ],
    { className: "pk-draft" },
  );
};

const failureView = (failure: AdminFailure, h: HtmlBuilder<Message>): Html =>
  Match.value(failure).pipe(
    Match.withReturnType<Html>(),
    Match.tag("Rejected", ({ rejection }) =>
      h.pre([h.Class("pk-failure")], [JSON.stringify(rejection, null, 2)]),
    ),
    Match.tag("Denied", ({ error }) =>
      h.pre([h.Class("pk-failure")], [JSON.stringify(error, null, 2)]),
    ),
    Match.tag("Unknown", () => h.empty),
    Match.exhaustive,
  );

const pendingView = (pending: Pending, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Class("pk-pending"), h.DataAttribute("paykit-pending", pending.status)],
    [
      h.span([], [pending.intent.kind]),
      h.span([h.Class("pk-muted")], [pending.commandId]),
      badge("pending", pending.status, h),
      Option.match(pending.reason, {
        onNone: () => h.empty,
        onSome: (reason) => h.span([h.Class("pk-muted")], [reason]),
      }),
      Option.match(pending.failure, {
        onNone: () => h.empty,
        onSome: (failure) => failureView(failure, h),
      }),
      pending.status === "Unknown"
        ? button("Retry", Message.ClickedRetryPending({ commandId: pending.commandId }), h)
        : h.empty,
    ],
  );

const eventsView = (account: AccountState, h: HtmlBuilder<Message>): Html =>
  card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Events"]),
            cardDescription(h, ["The account's complete event log, newest first."]),
          ],
        ),
        badge("feed", account.feed, h),
      ]),
      Option.match(account.error, {
        onNone: () => h.empty,
        onSome: (error) => alert(h, { variant: "destructive" }, [alertDescription(h, [error])]),
      }),
      account.events.length === 0
        ? empty(h, {
            title: "Waiting for the first event.",
            description: "The account's event stream fills this panel as it catches up.",
          })
        : h.ol(
            [h.Class("pk-events pk-event-log")],
            account.events.map((event) =>
              h.keyed("li")(
                event.seq,
                [h.Class("pk-event")],
                [
                  h.div(
                    [h.Class("pk-event-head")],
                    [
                      h.code([], [event.tag]),
                      h.span([h.Class("pk-muted")], [formatDateTime(event.at)]),
                    ],
                  ),
                  h.div([h.Class("pk-muted")], [event.commandId]),
                  h.pre([], [event.body]),
                ],
              ),
            ),
          ),
    ],
    { className: "pk-event-card" },
  );

const timelineDetail = (entry: TimelineEntry, currency: string | undefined): string => {
  const parts: string[] = [];
  if (entry.feature !== undefined) parts.push(entry.feature);
  if (entry.tier !== undefined) parts.push(`tier ${entry.tier}`);
  if (entry.holdId !== undefined) parts.push(`hold ${entry.holdId}`);
  if (entry.amount !== undefined) parts.push(`${entry.amount} units`);
  if (entry.credits !== undefined) parts.push(`${entry.credits} credits`);
  if (entry.charge !== undefined) parts.push(formatMoney(entry.charge, entry.currency ?? currency));
  if (entry.creditsAfter !== undefined) parts.push(`${entry.creditsAfter} left`);
  if (entry.invoiceId !== undefined) parts.push(`invoice ${entry.invoiceId}`);
  if (entry.reason !== undefined) parts.push(entry.reason);
  return parts.join(" · ");
};

/**
 * The bill's story: one period per boundary, rolled up per feature, then the
 * facts in reverse order. The raw event feed below stays the complete record;
 * this is the slice an operator opens when a number looks wrong.
 */
const timelineView = (account: AccountState, h: HtmlBuilder<Message>): Html => {
  const timeline = account.timeline;
  const currency = Option.match(account.entitlements, {
    onNone: () => undefined,
    onSome: (value) => value.currency,
  });
  const recent = timeline.entries.toReversed().slice(0, 50);

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Timeline"]),
            cardDescription(h, ["The bill's story, rolled up per period and per feature."]),
          ],
        ),
      ]),
      ...(timeline.periods.length === 0
        ? []
        : [
            h.div(
              [h.Class("pk-timeline-periods")],
              timeline.periods.toReversed().map((period) =>
                h.keyed("div")(
                  period.start.epochMilliseconds,
                  [h.Class("pk-timeline-period")],
                  [
                    h.h3([], [`${formatDateTime(period.start)} → ${formatDateTime(period.end)}`]),
                    h.p(
                      [h.Class("pk-muted")],
                      [
                        `+${period.credits.granted} granted · +${period.credits.purchased} purchased · −${period.credits.spent} spent · −${period.credits.expired} expired${
                          period.credits.balanceAfter === undefined
                            ? ""
                            : ` · ${period.credits.balanceAfter} left`
                        }`,
                      ],
                    ),
                    Object.keys(period.features).length === 0
                      ? h.empty
                      : table(
                          h,
                          [
                            tableHeader(h, [
                              tableRow(h, [
                                tableHead(h, ["Feature"]),
                                tableHead(h, ["Units"]),
                                tableHead(h, ["Credits"]),
                                tableHead(h, ["Charge"]),
                                tableHead(h, ["Holds"]),
                              ]),
                            ]),
                            tableBody(
                              h,
                              Object.entries(period.features).map(([feature, value]) =>
                                tableRow(
                                  h,
                                  [
                                    tableCell(h, [feature]),
                                    tableCell(h, [String(value.units)]),
                                    tableCell(h, [String(value.credits)]),
                                    tableCell(h, [formatMoney(value.charge, currency)]),
                                    tableCell(h, [
                                      `${value.held} held · ${value.settled} settled · ${value.released} released`,
                                    ]),
                                  ],
                                  { key: feature },
                                ),
                              ),
                            ),
                          ],
                          { ariaLabel: "Period features" },
                        ),
                  ],
                ),
              ),
            ),
          ]),
      recent.length === 0
        ? empty(h, {
            title: "No billing facts yet.",
            description: "Usage, holds and credit moves appear here as the feed delivers them.",
          })
        : h.ol(
            [h.Class("pk-events pk-timeline-events")],
            recent.map((entry) =>
              h.keyed("li")(
                entry.seq,
                [h.Class("pk-event")],
                [
                  h.div(
                    [h.Class("pk-event-head")],
                    [
                      h.code([], [entry.kind]),
                      h.span([h.Class("pk-muted")], [formatDateTime(entry.at)]),
                    ],
                  ),
                  h.div([h.Class("pk-muted")], [timelineDetail(entry, currency)]),
                ],
              ),
            ),
          ),
    ],
    {
      className: "pk-timeline",
      attributes: [h.DataAttribute("paykit-timeline", String(timeline.entries.length))],
    },
  );
};

const accountSummaryView = (account: AccountState, h: HtmlBuilder<Message>): Html => {
  const billing = Option.getOrNull(account.billing);
  if (billing === null) {
    return h.div(
      [
        h.Class("pk-stats"),
        h.DataAttribute("paykit-summary", "account"),
        h.AriaLabel("Account summary"),
      ],
      [
        stat("Plan", "—", "Waiting for billing", "neutral", h),
        stat("Status", "—", "Waiting for billing", "neutral", h),
        stat("Credits", "—", "Waiting for billing", "neutral", h),
        stat("Period ends", "—", "Waiting for billing", "neutral", h),
      ],
    );
  }
  const statusTone: Tone =
    billing.status === "grace"
      ? "warning"
      : standingValueOf(billing.status) === "good"
        ? "success"
        : "destructive";
  const price =
    billing.price === undefined
      ? "Free plan"
      : `${formatMoney(billing.price.amount, billing.price.currency)} / ${billing.price.interval}`;
  return h.div(
    [
      h.Class("pk-stats"),
      h.DataAttribute("paykit-summary", "account"),
      h.AriaLabel("Account summary"),
    ],
    [
      stat("Plan", billing.tier, price, "info", h),
      stat("Status", billing.status, `Standing: ${standingValueOf(billing.status)}`, statusTone, h),
      stat(
        "Credits",
        formatMoney(billing.credits, billing.currency),
        "Available balance",
        "neutral",
        h,
      ),
      stat(
        "Period ends",
        formatDateTime(billing.periodEnd),
        billing.cancelAtPeriodEnd ? "Cancels at period end" : `Every ${billing.interval}`,
        "neutral",
        h,
      ),
    ],
  );
};

const accountView = (model: Model, account: AccountState, h: HtmlBuilder<Message>): Html => {
  const pending =
    account.pending.length === 0
      ? h.empty
      : card(
          h,
          [
            cardHeader(h, [
              h.div(
                [],
                [
                  cardTitle(h, ["Pending commands"]),
                  cardDescription(h, ["Writes waiting for the server to answer."]),
                ],
              ),
            ]),
            h.ul(
              [h.Class("pk-pending-list")],
              account.pending.map((value) => pendingView(value, h)),
            ),
          ],
          { className: "pk-pending-card" },
        );

  const billingPanel = Option.match(account.billing, {
    onNone: () =>
      card(
        h,
        [
          cardHeader(h, [
            h.div(
              [],
              [
                cardTitle(h, ["Plan & billing"]),
                cardDescription(h, ["The standing this account is billed on."]),
              ],
            ),
          ]),
          h.p([h.Class("pk-muted")], ["Waiting for the billing snapshot…"]),
        ],
        { className: "pk-billing" },
      ),
    onSome: (value) => billingView(value, h),
  });

  const allowancesPanel = Option.match(account.entitlements, {
    onNone: () => h.empty,
    onSome: (value) => featureTable(value, h),
  });

  const usagePanel = Option.match(account.entitlements, {
    onNone: () => h.empty,
    onSome: (value) => usageView(value, h),
  });

  return h.section(
    [h.Class("pk-account")],
    [
      Option.match(account.notice, {
        onNone: () => h.empty,
        onSome: (notice) =>
          alert(h, { variant: "warning", role: "status" }, [
            alertDescription(h, [notice]),
            button("Dismiss", Message.DismissedNotice(), h, { variant: "ghost" }),
          ]),
      }),
      pending,
      section(
        "Overview",
        "What the standing includes and what this period has recorded.",
        [
          accountSummaryView(account, h),
          h.div([h.Class("pk-overview-grid")], [billingPanel, allowancesPanel, usagePanel]),
        ],
        h,
      ),
      section(
        "Operator",
        "Every write is a command; a preview asks the model without recording anything.",
        [
          Option.match(account.draft, {
            onNone: () => actionButtons(account, model.catalog, h),
            onSome: (draft) => draftView(model, account, draft, h),
          }),
          h.div(
            [h.Class("pk-operator-grid")],
            [previewView(model, account, h), verifyView(account, h)],
          ),
        ],
        h,
      ),
      section(
        "Activity",
        "The live feed, the bill's timeline and the holds still waiting.",
        [
          h.div(
            [h.Class("pk-activity-grid")],
            [timelineView(account, h), holdsView(account, h), eventsView(account, h)],
          ),
        ],
        h,
      ),
    ],
  );
};

const eventPreview = (body: string): string => (body.length > 96 ? `${body.slice(0, 96)}…` : body);

/** The event table: pick one, edit its display payload, then emit it. */
const devToolsEventsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const account = Option.getOrNull(model.account);
  const isAccountOpen = account !== null;
  const nextSeq = account === null ? 1 : nextEventSeq(account);

  return h.div(
    [h.Class("pk-devtools-body")],
    [
      h.p(
        [h.Class("pk-devtools-note")],
        [
          isAccountOpen
            ? "Click an event to inspect its payload, then emit it. Emit every event walks the whole table. Nothing here reaches the server. Synthetic events update the feed only; the Timeline folds the live decoded feed."
            : "No account is open. Emitting opens the lab account below, seeds a standing, and records the event against it. Nothing here reaches the server.",
        ],
      ),
      h.div(
        [h.Class("pk-devtools-actions")],
        [
          button("Emit selected", Message.ClickedEmitDevToolsEvent(), h),
          button("Emit every event", Message.ClickedEmitAllDevToolsEvents(), h),
          h.span(
            [h.Class("pk-devtools-meta")],
            [
              `${model.devTools.emitted} emitted · next seq ${nextSeq}${isAccountOpen ? "" : " · opens the lab account"}`,
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("pk-devtools-table-wrap")],
        [
          h.table(
            [h.Class("pk-devtools-table")],
            [
              h.thead([], [h.tr([], [h.th([], ["Event"]), h.th([], ["Payload preview"])])]),
              h.tbody(
                [],
                devToolsEvents.map((event) => {
                  const isSelected = event.tag === model.devTools.eventTag;
                  return h.keyed("tr")(
                    event.tag,
                    [
                      h.Class(
                        isSelected ? "pk-devtools-row pk-devtools-row-selected" : "pk-devtools-row",
                      ),
                    ],
                    [
                      h.td(
                        [],
                        [
                          uiButton(
                            h,
                            {
                              onClick: Message.UpdatedDevToolsEventTag({ value: event.tag }),
                              variant: "link",
                              className: "pk-devtools-link",
                              attributes: [h.AriaPressed(isSelected ? "true" : "false")],
                            },
                            [event.tag],
                          ),
                        ],
                      ),
                      h.td([h.Class("pk-devtools-preview")], [eventPreview(event.body)]),
                    ],
                  );
                }),
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("pk-devtools-fields")],
        [
          textField(
            "devtools-command-id",
            "Command id",
            model.devTools.commandId,
            (value) => Message.UpdatedDevToolsCommandId({ value }),
            h,
          ),
          textAreaField(
            "devtools-body",
            `Payload for ${model.devTools.eventTag}`,
            model.devTools.eventBody,
            (value) => Message.UpdatedDevToolsEventBody({ value }),
            h,
            5,
          ),
        ],
      ),
      h.p(
        [h.Class("pk-devtools-meta")],
        ["The payload is display-only; the console never decodes it."],
      ),
    ],
  );
};

/** Open an account the deployment does not have, or replace the open one. */
const devToolsReadsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const account = Option.getOrNull(model.account);
  const isAccountOpen = account !== null;
  const status =
    account === null
      ? "No account open."
      : `${account.id} · ${account.feed} · ${account.events.length} events · ${
          Option.isSome(account.billing) ? "standing seeded" : "no standing"
        }`;

  return h.div(
    [h.Class("pk-devtools-body")],
    [
      h.p(
        [h.Class("pk-devtools-note")],
        [
          "Open an account the deployment does not have, or seed the standing, allowances and holds of the open one.",
        ],
      ),
      textField(
        "devtools-account-id",
        "Account id",
        model.devTools.accountId,
        (value) => Message.UpdatedDevToolsAccountId({ value }),
        h,
      ),
      h.div(
        [h.Class("pk-devtools-actions")],
        [
          button("Open account", Message.ClickedOpenDevToolsAccount(), h, {
            isDisabled: model.devTools.accountId.trim() === "",
          }),
          button("Seed demo data", Message.ClickedSeedDevToolsSnapshot(), h, {
            isDisabled: !isAccountOpen,
          }),
          button("Fail reads", Message.ClickedFailDevToolsReads(), h, {
            isDisabled: !isAccountOpen,
          }),
        ],
      ),
      h.p([h.Class("pk-devtools-meta")], [status]),
    ],
  );
};

/** Move the feed without a server, or reset the lab. */
const devToolsFeedView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const account = Option.getOrNull(model.account);
  const isAccountOpen = account !== null;
  const cursor = account === null ? "—" : String(Option.getOrElse(account.cursor, () => "—"));
  return h.div(
    [h.Class("pk-devtools-body")],
    [
      h.p(
        [h.Class("pk-devtools-note")],
        ["Move the feed without a server. A hold event still re-reads the open account's holds."],
      ),
      h.div(
        [h.Class("pk-devtools-summary")],
        [
          h.span([], [`feed: ${account?.feed ?? "no account"}`]),
          h.span([], [`cursor: ${cursor}`]),
          h.span([], [`events: ${account?.events.length ?? 0}`]),
          h.span([], [`pending: ${account?.pending.length ?? 0}`]),
        ],
      ),
      h.div(
        [h.Class("pk-devtools-actions")],
        [
          button("Catch up feed", Message.ClickedCatchUpDevToolsFeed(), h, {
            isDisabled: !isAccountOpen,
          }),
          button("Fail feed", Message.ClickedFailDevToolsFeed(), h, {
            isDisabled: !isAccountOpen,
          }),
          button("Reset lab", Message.ClickedResetDevTools(), h, {
            isDisabled: !isAccountOpen,
          }),
        ],
      ),
    ],
  );
};

const devToolsTabView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(model.devTools.tab).pipe(
    Match.withReturnType<Html>(),
    Match.when("events", () => devToolsEventsView(model, h)),
    Match.when("reads", () => devToolsReadsView(model, h)),
    Match.when("feed", () => devToolsFeedView(model, h)),
    Match.exhaustive,
  );

/**
 * The local event lab, shaped like the rat-stack devtools overlay: a floating
 * trigger and a tabbed panel, so it never competes with the console layout.
 * It is inert unless `Flags.devTools` says so.
 */
const devToolsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.devTools.isEnabled
    ? h.div(
        [],
        [
          uiButton(
            h,
            {
              onClick: Message.ToggledDevTools({ isOpen: !model.devTools.isOpen }),
              variant: "default",
              size: "icon",
              className: "pk-devtools-trigger",
              ariaLabel: "Paykit dev tools",
              title: "Paykit dev tools",
              attributes: [h.AriaExpanded(model.devTools.isOpen)],
            },
            ["🛠"],
          ),
          model.devTools.isOpen
            ? h.section(
                [
                  h.Class("pk-devtools-panel"),
                  h.AriaLabel("Paykit dev tools"),
                  h.DataAttribute("paykit-devtools", "open"),
                ],
                [
                  h.header(
                    [h.Class("pk-devtools-panel-head")],
                    [
                      h.span([h.Class("pk-devtools-title")], ["Paykit dev tools"]),
                      tabList(
                        h,
                        { label: "Paykit dev tools", className: "pk-devtools-tabs" },
                        devToolsTabs.map(({ tab: value, label }) =>
                          tab(
                            h,
                            {
                              isActive: model.devTools.tab === value,
                              onClick: Message.SelectedDevToolsTab({ tab: value }),
                              className: "pk-devtools-tab",
                            },
                            [label],
                          ),
                        ),
                      ),
                      button("Close", Message.ToggledDevTools({ isOpen: false }), h),
                    ],
                  ),
                  devToolsTabView(model, h),
                ],
              )
            : h.empty,
        ],
      )
    : h.empty;

const pageBodyView = (model: Model, h: HtmlBuilder<Message>): Html => {
  switch (model.route._tag) {
    case "Accounts":
      return accountsView(model, h);
    case "Account":
      return Option.match(model.account, {
        onNone: () => accountsView(model, h),
        onSome: (account) => accountView(model, account, h),
      });
    case "Plans":
      return plansView(model, h);
    case "Features":
      return featuresView(model, h);
  }
};

/** The console's shell: a navigation rail and one page of content. */
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Paykit admin",
  body: h.div(
    [h.Class("pk-admin")],
    [
      sidebarView(model, h),
      h.div(
        [h.Class("pk-content")],
        [
          topbarView(model, h),
          h.main(
            [h.Class("pk-main")],
            [
              pageHeadView(model, h),
              Option.match(model.catalogError, {
                onNone: () => h.empty,
                onSome: (error) =>
                  alert(h, { variant: "destructive" }, [
                    alertDescription(h, [
                      `Catalog unavailable: ${error}. Actions that need the catalog are disabled.`,
                    ]),
                  ]),
              }),
              pageBodyView(model, h),
            ],
          ),
        ],
      ),
      devToolsView(model, h),
    ],
  ),
});
