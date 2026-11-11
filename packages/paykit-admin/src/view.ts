import { BillingOverview, actionsFor } from "@potion.run/paykit/Admin";
import {
  type Allowance,
  type BillingReadRow,
  type Catalog,
  type Feature,
  type BillingStateView,
  type EntitlementsState,
  type Tier,
  type TimelineEntry,
  AccountId,
  outstandingRefundOf,
  planIdOf,
} from "@potion.run/paykit/Read";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { OperatorActions } from "./actions.ts";
import { devToolsEvents, devToolsTabs, nextEventSeq } from "./DevTools.ts";
import {
  formatCount,
  formatCredits,
  formatDate,
  formatDateTime,
  formatMoney,
  formatOptionalDate,
  formatOptionalDateTime,
} from "./format.ts";
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
import { alert, alertDescription, alertTitle } from "./ui/alert.ts";
import { badge as uiBadge, type BadgeVariant } from "./ui/badge.ts";
import { button as uiButton, type ButtonSize, type ButtonVariant } from "./ui/button.ts";
import { card, cardDescription, cardHeader, cardTitle } from "./ui/card.ts";
import { empty } from "./ui/empty.ts";
import { field } from "./ui/field.ts";
import { input } from "./ui/input.ts";
import { miniBars } from "./ui/mini-bars.ts";
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
  overview: "M3 3v18h18 M7 15l4-4 3 3 5-6",
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

/** Initials from a customer's name, so an avatar is not always "AC". */
const initialsOfName = (name: string): string => {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");

  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  const initials = letters.join("").toUpperCase();

  return initials === "" ? initialsOf(name) : initials;
};

const accountAvatar = (
  account: string,
  h: HtmlBuilder<Message>,
  isSmall = false,
  initials = initialsOf(account),
): Html =>
  h.span(
    [h.Class(isSmall ? "pk-avatar pk-avatar-sm" : "pk-avatar"), h.AriaHidden(true)],
    [initials],
  );

const standingValueOf = (status: string): "good" | "grace" | "blocked" =>
  status === "grace" ? "grace" : status === "active" || status === "trialing" ? "good" : "blocked";

/**
 * One status for the page: the standing, the status and "canceling" are three
 * internal machines, and an operator needs one answer and one reason.
 */
type StatusKey =
  | "active"
  | "trial"
  | "past_due"
  | "suspended"
  | "canceling"
  | "canceled"
  | "expired";

const STATUS_PRESENTATION: Readonly<Record<StatusKey, { label: string; tone: Tone }>> = {
  active: { label: "Active", tone: "success" },
  trial: { label: "Trial", tone: "info" },
  past_due: { label: "Past due", tone: "warning" },
  suspended: { label: "Suspended", tone: "destructive" },
  canceling: { label: "Canceling", tone: "warning" },
  canceled: { label: "Canceled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

const statusKeyOf = (status: string, standing: string, cancelAtPeriodEnd: boolean): StatusKey =>
  Match.value([status, standing, cancelAtPeriodEnd] as const).pipe(
    Match.withReturnType<StatusKey>(),
    Match.when(
      ([value]) => value === "expired",
      () => "expired",
    ),
    Match.when(
      ([value]) => value === "canceled",
      () => "canceled",
    ),
    Match.when(
      ([, value]) => value === "blocked",
      () => "suspended",
    ),
    Match.when(
      ([value]) => value === "grace",
      () => "past_due",
    ),
    Match.when(
      ([, , canceling]) => canceling,
      () => "canceling",
    ),
    Match.when(
      ([value]) => value === "trialing",
      () => "trial",
    ),
    Match.orElse(() => "active"),
  );

const statusWordOf = (value: string): string =>
  Match.value(value).pipe(
    Match.withReturnType<string>(),
    Match.when("trialing", () => "Trial"),
    Match.when("grace", () => "Past due"),
    Match.when("canceled", () => "Canceled"),
    Match.when("expired", () => "Expired"),
    Match.when("active", () => "Active"),
    Match.orElse(() => value),
  );

const standingWordOf = (value: string): string =>
  Match.value(value).pipe(
    Match.withReturnType<string>(),
    Match.when("good", () => "Active"),
    Match.when("grace", () => "Past due"),
    Match.when("blocked", () => "Suspended"),
    Match.orElse(() => value),
  );

const feedLabelOf = (value: string): string =>
  Match.value(value).pipe(
    Match.withReturnType<string>(),
    Match.when("CatchingUp", () => "Connecting"),
    Match.when("Failed", () => "Disconnected"),
    Match.orElse(() => value),
  );

const pendingLabelOf = (value: string): string =>
  Match.value(value).pipe(
    Match.withReturnType<string>(),
    Match.when("Unknown", () => "Outcome unknown - retry"),
    Match.orElse(() => value),
  );

const kindLabelOf = (kind: string | undefined): string =>
  Match.value(kind).pipe(
    Match.withReturnType<string>(),
    Match.when("flag", () => "On/off"),
    Match.when("non_consumable", () => "Seats"),
    Match.orElse(() => "Usage"),
  );

type StatusSummary = {
  readonly key: StatusKey;
  readonly label: string;
  readonly tone: Tone;
  /** One sentence: why this customer needs help, or what happens next. */
  readonly reason: string;
};

const joinParts = (parts: ReadonlyArray<string | undefined>): string =>
  parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");

/** The status and the one sentence under it, from the billing facts the page holds. */
const statusSummaryOf = (
  billing: BillingStateView,
  entitlements: Option.Option<EntitlementsState>,
): StatusSummary => {
  const standing = Option.match(entitlements, {
    onNone: () => standingValueOf(billing.status),
    onSome: (state) => state.standing,
  });

  const key = statusKeyOf(billing.status, standing, billing.cancelAtPeriodEnd);
  const presentation = STATUS_PRESENTATION[key];

  const failed =
    billing.dunningAttempts === 0
      ? undefined
      : `Payment failed ${
          billing.dunningAttempts === 1 ? "once" : `${billing.dunningAttempts} times`
        }`;

  const accessEnd =
    billing.graceUntil === undefined ? undefined : `access ends ${formatDate(billing.graceUntil)}`;

  const limited = Option.match(entitlements, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (state) =>
      Object.entries(state.features)
        .filter(
          ([, feature]) => feature.allowed === false && (feature.kind ?? "metered") !== "flag",
        )
        .map(([name]) => name),
  });

  const reason = Match.value(key).pipe(
    Match.withReturnType<string>(),
    Match.when("expired", () => joinParts([failed, `Ended ${formatDate(billing.periodEnd)}`])),
    Match.when("canceled", () => joinParts([failed, `Ended ${formatDate(billing.periodEnd)}`])),
    Match.when("suspended", () => joinParts(["Access is suspended", failed, accessEnd])),
    Match.when("past_due", () => joinParts([failed ?? "Payment is past due", accessEnd])),
    Match.when("canceling", () => joinParts([failed, `Cancels ${formatDate(billing.periodEnd)}`])),
    Match.when("trial", () =>
      joinParts([failed, `Trial ends ${formatDate(billing.trialEndsAt ?? billing.periodEnd)}`]),
    ),
    Match.when("active", () =>
      joinParts([
        failed,
        limited.length > 0
          ? `Usage limit reached: ${limited.join(", ")}`
          : `Renews ${formatDate(billing.periodEnd)}`,
      ]),
    ),
    Match.exhaustive,
  );

  return { key, label: presentation.label, tone: presentation.tone, reason };
};

const statusSummaryOfFacts = (
  status: string,
  standing: string,
  canceling: boolean,
): StatusSummary => {
  const key = statusKeyOf(status, standing, canceling);
  const presentation = STATUS_PRESENTATION[key];

  return { key, label: presentation.label, tone: presentation.tone, reason: "" };
};

/** The same one status for a list row, which carries no deadline or trial end. */
const statusSummaryOfRow = (row: BillingReadRow): StatusSummary => {
  const key = statusKeyOf(row.status, row.standing, row.cancelAtPeriodEnd);
  const presentation = STATUS_PRESENTATION[key];

  const limited = Object.entries(row.features).some(
    ([, feature]) => feature.allowed === false && (feature.kind ?? "metered") !== "flag",
  );

  return {
    key,
    label: presentation.label,
    tone: presentation.tone,
    reason:
      key === "active" && limited ? "Usage limit reached" : `Renews ${formatDate(row.periodEnd)}`,
  };
};

/**
 * What the summary's last tile should say. "Next bill · Renews" is the
 * ordinary case; a trial, a grace deadline, a scheduled cancellation and a
 * finished plan each name a different moment, and an operator should not have
 * to infer it from the status pill.
 */
type NextBill = {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: Tone;
};

const nextBillOf = (billing: BillingStateView): NextBill => {
  if (billing.status === "expired" || billing.status === "canceled") {
    return {
      label: "Ended",
      value: formatDate(billing.periodEnd),
      detail: billing.status === "expired" ? "Plan expired" : "Plan canceled",
      tone: "neutral",
    };
  }

  if (billing.status === "grace") {
    return {
      label: "Access ends",
      value: formatDate(billing.graceUntil ?? billing.periodEnd),
      detail: billing.dunningAttempts === 0 ? "Grace period" : "Payment is past due",
      tone: "warning",
    };
  }

  if (billing.status === "trialing") {
    return {
      label: "Trial ends",
      value: formatDate(billing.trialEndsAt ?? billing.periodEnd),
      detail: "Convert or end",
      tone: "info",
    };
  }

  if (billing.cancelAtPeriodEnd) {
    return {
      label: "Cancels",
      value: formatDate(billing.periodEnd),
      detail: "At period end",
      tone: "warning",
    };
  }

  return {
    label: "Next bill",
    value: formatDate(billing.periodEnd),
    detail: "Renews",
    tone: "neutral",
  };
};

/** The plan's display name, from the catalog; the id is the fallback. */
const planLabelOf = (catalog: Option.Option<Catalog>, tier: string): string =>
  Option.match(catalog, {
    onNone: () => tier,
    onSome: (value) => value.tiers.find((entry) => entry.id === tier)?.name ?? tier,
  });

const featureLabelOf = (catalog: Option.Option<Catalog>, feature: string): string =>
  Option.match(catalog, {
    onNone: () => feature,
    onSome: (value) => value.features.find((entry) => entry.id === feature)?.name ?? feature,
  });

type UsageFeatures = Readonly<
  Record<
    string,
    {
      readonly kind?: "metered" | "flag" | "non_consumable";
      readonly included: number | "unlimited" | null;
      readonly used: number;
    }
  >
>;

/**
 * The one usage number a list row has room for: the first counted feature's
 * `used / included`, or the credit balance when the customer buys no units.
 */
const usageSummaryOf = (
  catalog: Option.Option<Catalog>,
  features: UsageFeatures,
  credits: number,
) => {
  const entries = Object.entries(features)
    .filter(([, feature]) => (feature.kind ?? "metered") !== "flag")
    .toSorted(([left], [right]) => left.localeCompare(right));

  const counted = entries
    .filter(([, feature]) => typeof feature.included === "number")
    .toSorted(([, left], [, right]) => {
      const leftIncluded = typeof left.included === "number" ? left.included : 1;
      const rightIncluded = typeof right.included === "number" ? right.included : 1;

      return right.used / Math.max(rightIncluded, 1) - left.used / Math.max(leftIncluded, 1);
    });

  const first = counted[0] ?? entries[0];

  if (first === undefined) return { value: formatCredits(credits), detail: "Credits" };

  const [feature, value] = first;

  return {
    value:
      value.included === null || value.included === "unlimited"
        ? `${value.used.toLocaleString("en")} used`
        : `${value.used.toLocaleString("en")} / ${value.included.toLocaleString("en")}`,
    detail: featureLabelOf(catalog, feature),
  };
};

const usageCellOf = (
  catalog: Option.Option<Catalog>,
  features: UsageFeatures,
  credits: number,
  h: HtmlBuilder<Message>,
): Html => {
  const usage = usageSummaryOf(catalog, features, credits);

  return h.div(
    [h.Class("pk-usage-cell")],
    [
      h.span([h.Class("pk-usage-value")], [usage.value]),
      h.span([h.Class("pk-usage-feature")], [usage.detail]),
    ],
  );
};

/** The everyday names for the commands an operator sends. */
const actionLabelOf = (action: string): string => {
  switch (action) {
    case "GrantCredits":
      return "Add credits";
    case "ExtendTrial":
      return "Extend trial";
    case "ChangeTier":
      return "Change plan";
    case "ScheduleTierChange":
      return "Schedule plan change";
    case "WithdrawTierChange":
      return "Withdraw plan change";
    case "EnterGrace":
      return "Set access deadline";
    case "RecordPayment":
      return "Record payment";
    case "RecordPaymentFailure":
      return "Record failed payment";
    case "Recover":
      return "Restore access";
    case "Expire":
      return "End plan";
    case "ScheduleCancellation":
      return "Cancel at period end";
    case "Resume":
      return "Resume plan";
    case "Refund":
      return "Refund payment";
    case "ReverseRefund":
      return "Reverse refund";
    default:
      return action;
  }
};

/** Why the deployment flagged a row on the overview, without repeating the status. */
const attentionReasonLabel = (reason: string, dunningAttempts: number): string => {
  switch (reason) {
    case "past_due":
      return dunningAttempts === 0
        ? "Payment is past due"
        : formatCount(
            dunningAttempts,
            dunningAttempts === 1 ? "failed payment" : "failed payments",
          );
    case "canceling":
      return "Cancels at period end";
    case "usage_limit_reached":
      return "Usage limit reached";
    default:
      return reason;
  }
};

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

/** A native disclosure: the detail is one click away and out of the first screen. */
const disclosure = (
  title: string,
  description: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
  className: string,
): Html =>
  h.details(
    [h.Class(`pk-disclosure ${className}`)],
    [
      h.summary(
        [h.Class("pk-disclosure-summary")],
        [
          h.span([h.Class("pk-disclosure-title")], [title]),
          ...(description === ""
            ? []
            : [h.span([h.Class("pk-disclosure-description")], [description])]),
        ],
      ),
      h.div([h.Class("pk-disclosure-body")], children),
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
      h.nav(
        [h.Class("pk-nav"), h.AriaLabel("Console")],
        [
          navItem(
            "Overview",
            iconPaths.overview,
            model.route._tag === "Overview",
            Message.ClickedOverview(),
            h,
          ),
          navItem(
            "Customers",
            iconPaths.accounts,
            model.route._tag === "Accounts" || model.route._tag === "Account",
            Message.ClosedAccount(),
            h,
          ),
          h.p([h.Class("pk-nav-label")], ["Plans & features"]),
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
      ...Option.match(model.actor, {
        onNone: (): ReadonlyArray<Html> => [],
        onSome: (actor) => [
          h.div(
            [h.Class("pk-sidebar-footer")],
            [
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
            ],
          ),
        ],
      }),
    ],
  );

const breadcrumbItems = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  switch (model.route._tag) {
    case "Accounts":
      return [h.strong([], ["Customers"])];
    case "Account":
      return [
        h.span([], ["Customers"]),
        icon(h, iconPaths.chevronRight, "pk-crumb-icon"),
        h.strong([], [model.route.account]),
      ];
    case "Overview":
      return [h.strong([], ["Overview"])];
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
          h.h1([], ["Customers"]),
          h.p(
            [h.Class("pk-page-subtitle")],
            ["Every customer, their plan and what they owe next."],
          ),
        ],
      ),
      h.div(
        [h.Class("pk-page-actions")],
        [button("Refresh", Message.ClickedRefresh(), h, { variant: "default" })],
      ),
    ],
  );

const accountPageHead = (account: AccountState, h: HtmlBuilder<Message>): Html => {
  const billing = Option.getOrNull(account.billing);
  const customer = billing?.customer;
  const name = customer?.name?.trim() ?? "";
  const displayName = name === "" ? account.id : name;
  const initials = name === "" ? initialsOf(account.id) : initialsOfName(name);
  const summary = billing === null ? null : statusSummaryOf(billing, account.entitlements);
  const status = billing?.status ?? "";
  const standing = status === "" ? "" : standingValueOf(status);

  return h.div(
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
                "All customers",
              ]),
            ],
          ),
          h.div(
            [h.Class("pk-detail-identity")],
            [
              accountAvatar(account.id, h, false, initials),
              h.div(
                [h.Class("pk-detail-copy")],
                [
                  h.p([h.Class("pk-eyebrow")], ["Customer"]),
                  h.div(
                    [h.Class("pk-detail-title-row")],
                    [
                      h.h1([], [displayName]),
                      summary === null ? h.empty : statusPill(summary, status, standing, h),
                    ],
                  ),
                  h.div(
                    [h.Class("pk-customer-meta")],
                    [
                      ...(customer?.email === undefined
                        ? []
                        : [h.span([h.Class("pk-customer-email")], [customer.email])]),
                      ...(customer === undefined
                        ? []
                        : [
                            h.span(
                              [h.Class("pk-customer-since")],
                              [`Customer since ${formatDate(customer.createdAt)}`],
                            ),
                          ]),
                      h.span([h.Class("pk-customer-id")], [`Customer ID ${account.id}`]),
                    ],
                  ),
                  summary === null
                    ? h.empty
                    : h.p(
                        [
                          h.Class("pk-status-reason"),
                          h.DataAttribute("paykit-status-reason", summary.key),
                        ],
                        [summary.reason],
                      ),
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
};

const catalogPageHead = (title: string, subtitle: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("pk-page-head")],
    [
      h.div(
        [],
        [
          h.p([h.Class("pk-eyebrow")], ["Plans & features"]),
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
    case "Overview":
      return h.div(
        [h.Class("pk-page-head")],
        [
          h.div(
            [],
            [
              h.p([h.Class("pk-eyebrow")], ["Billing"]),
              h.h1([], ["Overview"]),
              h.p(
                [h.Class("pk-page-subtitle")],
                ["Estimated revenue and the customers who need attention."],
              ),
            ],
          ),
          h.div(
            [h.Class("pk-page-actions")],
            [button("Refresh", Message.ClickedRefresh(), h, { variant: "default" })],
          ),
        ],
      );
    case "Plans":
      return catalogPageHead(
        "Plans",
        "The plans this deployment sells, what they include, and what they cost.",
        h,
      );
    case "Features":
      return catalogPageHead(
        "Features",
        "Every feature the deployment declares and how it is counted.",
        h,
      );
  }
};

const badgeVariantOf = (kind: string, value: string): BadgeVariant => {
  if (kind === "feed") {
    return Match.value(value).pipe(
      Match.withReturnType<BadgeVariant>(),
      Match.when("Live", () => "success"),
      Match.when("CatchingUp", () => "warning"),
      Match.orElse(() => "destructive"),
    );
  }

  if (kind === "pending") {
    return Match.value(value).pipe(
      Match.withReturnType<BadgeVariant>(),
      Match.when("Accepted", () => "success"),
      Match.when("Sending", () => "info"),
      Match.when("Unknown", () => "warning"),
      Match.orElse(() => "destructive"),
    );
  }

  if (kind === "holds") {
    return Number(value) === 0 ? "secondary" : "info";
  }

  if (kind === "hold") {
    return Match.value(value).pipe(
      Match.withReturnType<BadgeVariant>(),
      Match.when("open", () => "info"),
      Match.when("settled", () => "success"),
      Match.orElse(() => "secondary"),
    );
  }

  return "secondary";
};

const badgeTextOf = (kind: string, value: string): string => {
  switch (kind) {
    case "feed":
      return feedLabelOf(value);
    case "pending":
      return pendingLabelOf(value);
    default:
      return value;
  }
};

const badgeVariantOfTone = (tone: Tone): BadgeVariant => (tone === "neutral" ? "secondary" : tone);

/**
 * One status pill. The hooks stay on the raw values, and the label is the
 * operator's word for them.
 */
const statusPill = (
  summary: StatusSummary,
  status: string,
  standing: string,
  h: HtmlBuilder<Message>,
): Html =>
  uiBadge(
    h,
    {
      variant: badgeVariantOfTone(summary.tone),
      className: "pk-badge-status pk-status-pill",
      attributes: [
        h.DataAttribute("paykit-status", status),
        h.DataAttribute("paykit-standing", standing),
        h.DataAttribute("paykit-state", summary.key),
      ],
    },
    [summary.label],
  );

const badge = (kind: string, value: string, h: HtmlBuilder<Message>) =>
  uiBadge(
    h,
    {
      variant: badgeVariantOf(kind, value),
      className: `pk-badge-${kind}`,
      attributes: [h.DataAttribute(`paykit-${kind}`, value)],
    },
    [badgeTextOf(kind, value)],
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
  labelOf: (value: string) => string = (value) => value,
): ReadonlyArray<{ readonly value: string; readonly label: string }> => [
  { value: "", label: allLabel },
  ...values.map((value) => ({ value, label: labelOf(value) })),
];

const accountsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const filter = model.accounts.filter;
  const standing = Option.getOrElse(filter.standing, () => "");
  const status = Option.getOrElse(filter.status, () => "");
  const tier = Option.getOrElse(filter.tier, () => "");
  const search = Option.getOrElse(filter.search, () => "");

  const hasFilter =
    Option.isSome(filter.standing) ||
    Option.isSome(filter.status) ||
    Option.isSome(filter.tier) ||
    Option.isSome(filter.search);

  // A list is a point-in-time read, never a live view: say when it was read,
  // or say the read time is unknown. The panel never presents the rows as
  // current, because the account it opens is live and this is not.
  const asOf = Option.getOrUndefined(model.accounts.asOf);

  const asOfText =
    asOf === undefined
      ? `Updated · read time unknown · not live${model.accounts.state === "Loading" ? " · refreshing…" : ""}`
      : `Updated ${formatDateTime(asOf)} · not live${model.accounts.state === "Loading" ? " · refreshing…" : ""}`;

  const tierOptions = Option.match(model.catalog, {
    onNone: () => [{ value: "", label: "All plans" }],
    onSome: (catalog: Catalog) =>
      filterOptions(
        catalog.tiers.map((entry) => entry.id),
        "All plans",
        (value) => planLabelOf(model.catalog, value),
      ),
  });

  return h.div(
    [h.Class("pk-accounts-page")],
    [
      card(
        h,
        [
          cardHeader(h, [
            h.div(
              [],
              [
                cardTitle(h, ["Customers"]),
                cardDescription(h, ["Every customer with their plan, status and current period."]),
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
                      model.accounts.rows.length === 1 ? "customer" : "customers"
                    } on this page`,
                  ],
                ),
              ],
            ),
          ]),
          h.div(
            [h.Class("pk-filters")],
            [
              h.div(
                [h.Class("pk-filter-search")],
                [
                  input(h, {
                    id: "filter-search",
                    value: search,
                    onInput: (value) => Message.UpdatedSearch({ value }),
                    placeholder: "Search name, email or ID",
                    attributes: [h.AriaLabel("Search customers")],
                  }),
                ],
              ),
              selectControl(
                "filter-standing",
                "Access",
                standing,
                filterOptions(["good", "grace", "blocked"], "All access", standingWordOf),
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
                  statusWordOf,
                ),
                (value) => Message.UpdatedStatusFilter({ value }),
                h,
              ),
              selectControl(
                "filter-tier",
                "Plan",
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
                alertDescription(h, [`Could not load customers: ${error}`]),
              ]),
          }),
          model.accounts.rows.length === 0
            ? model.accounts.state === "Loading"
              ? h.p([h.Class("pk-muted pk-loading")], ["Loading customers…"])
              : empty(h, {
                  title: hasFilter
                    ? "No customers match these filters."
                    : "No customers on this page.",
                  description: hasFilter
                    ? "Adjust the filters or refresh the list."
                    : "Customers appear here after their first billing event reaches the projection.",
                })
            : table(
                h,
                [
                  tableHeader(h, [
                    tableRow(h, [
                      tableHead(h, ["Customer"]),
                      tableHead(h, ["Plan"]),
                      tableHead(h, ["Status"]),
                      tableHead(h, ["Usage this period"]),
                      tableHead(h, ["Credits"]),
                      tableHead(h, ["Next bill"]),
                      tableHead(h, [h.span([h.Class("pk-sr-only")], ["Open customer"])]),
                    ]),
                  ]),
                  tableBody(
                    h,
                    model.accounts.rows.map((row: BillingReadRow) => {
                      const name = row.customer?.name?.trim() ?? "";
                      const label = name === "" ? row.account : name;

                      return tableRow(
                        h,
                        [
                          tableCell(
                            h,
                            [
                              h.div(
                                [h.Class("pk-account-cell")],
                                [
                                  accountAvatar(
                                    row.account,
                                    h,
                                    true,
                                    name === "" ? initialsOf(row.account) : initialsOfName(name),
                                  ),
                                  h.div(
                                    [h.Class("pk-account-copy")],
                                    [
                                      h.span([h.Class("pk-account-name")], [label]),
                                      h.span(
                                        [h.Class("pk-account-meta")],
                                        [
                                          row.customer?.email ??
                                            (row.dunningAttempts === 0
                                              ? row.account
                                              : formatCount(
                                                  row.dunningAttempts,
                                                  row.dunningAttempts === 1
                                                    ? "failed payment"
                                                    : "failed payments",
                                                )),
                                        ],
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ],
                            { className: "pk-account-id" },
                          ),
                          tableCell(h, [
                            h.div(
                              [h.Class("pk-plan-cell")],
                              [
                                h.span(
                                  [h.Class("pk-plan-name")],
                                  [planLabelOf(model.catalog, row.tier)],
                                ),
                              ],
                            ),
                          ]),
                          tableCell(h, [
                            statusPill(statusSummaryOfRow(row), row.status, row.standing, h),
                          ]),
                          tableCell(h, [usageCellOf(model.catalog, row.features, row.credits, h)]),
                          tableCell(h, [row.credits.toLocaleString("en")]),
                          tableCell(h, [
                            h.div(
                              [h.Class("pk-account-copy")],
                              [
                                h.span([h.Class("pk-account-name")], [formatDate(row.periodEnd)]),
                                ...(row.cancelAtPeriodEnd
                                  ? [h.span([h.Class("pk-account-meta")], ["Cancels"])]
                                  : row.status === "expired" || row.status === "canceled"
                                    ? [h.span([h.Class("pk-account-meta")], ["Ended"])]
                                    : []),
                              ],
                            ),
                          ]),
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
                      );
                    }),
                  ),
                ],
                { ariaLabel: "Customers" },
              ),
          h.div(
            [h.Class("pk-table-footer")],
            [
              h.span(
                [h.Class("pk-muted")],
                [
                  model.accounts.state === "Loading"
                    ? "Refreshing customers…"
                    : Option.isSome(model.accounts.next)
                      ? "More customers match these filters."
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

const featureDisplay = (
  catalog: Option.Option<Catalog>,
  id: string,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(catalog, {
    onNone: () => h.span([h.Class("pk-catalog-feature-name")], [id]),
    onSome: (value) => catalogFeature(value, id, h),
  });

const includedLabel = (allowance: Allowance): string =>
  allowance.kind === "flag"
    ? "On/off"
    : allowance.included === "unlimited"
      ? "Unlimited"
      : String(allowance.included);

const overageLabel = (overage: Allowance["overage"]): string =>
  Match.value(overage).pipe(
    Match.withReturnType<string>(),
    Match.when("block", () => "stops at the limit"),
    Match.when("bill", () => "billed after the limit"),
    Match.orElse(() => "allowed past the limit"),
  );

const allowanceTerms = (allowance: Allowance): string => {
  if (allowance.kind === "flag") return "—";
  const terms: string[] = [overageLabel(allowance.overage)];

  if (allowance.carryOver === true) terms.push("carry over");

  if (allowance.cap !== undefined) terms.push(`cap ${formatCount(allowance.cap, "units")}`);

  if (allowance.unitPrice !== undefined)
    terms.push(`${formatMoney(allowance.unitPrice.amount, allowance.unitPrice.currency)} / unit`);

  if (allowance.moneyCap !== undefined)
    terms.push(`${formatMoney(allowance.moneyCap, allowance.unitPrice?.currency)} cap`);

  return terms.length === 0 ? "—" : terms.join(" · ");
};

const tierKindOf = (tier: Tier): "subscription" | "one_off" => tier.kind ?? "subscription";

const grantsTable = (
  catalog: Catalog,
  allowances: ReadonlyArray<Allowance>,
  ariaLabel: string,
  h: HtmlBuilder<Message>,
): Html =>
  table(
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
        allowances.map((allowance) =>
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
    { ariaLabel },
  );

const planGrants = (catalog: Catalog, tier: Tier, h: HtmlBuilder<Message>): Html =>
  tier.grants.length === 0
    ? h.p([h.Class("pk-muted")], ["This pack sells credits only."])
    : grantsTable(catalog, tier.grants, `${tier.name ?? tier.id} grants`, h);

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
        title: Option.isSome(model.catalogError)
          ? "Plans unavailable."
          : "Loading plans & features…",
        description: Option.match(model.catalogError, {
          onNone: () => "The deploy's plans are on their way.",
          onSome: (error) => `The deploy did not answer with its plans: ${error}.`,
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
          ["Subscriptions", String(subscriptions), "Recurring plan", "info"],
          ["One-off packs", String(oneOff), "Credits only", "info"],
          ["Priced", String(priced), "With a price", "success"],
        ],
        h,
      ),
      tiers.length === 0
        ? empty(h, {
            title: "No plans declared.",
            description: "The deploy declares no plans.",
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
          ["Usage", String(metered), "Counted usage", "info"],
          ["On/off", String(flags), "Switched on or off", "info"],
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
                description: "The deploy declares no features.",
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
                              kindLabelOf(feature.kind),
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

/** Money a billing page sums per currency, as one readable line. */
const moneyByCurrency = (amounts: Readonly<Record<string, number>> | undefined): string => {
  const entries = Object.entries(amounts ?? {});

  return entries.length === 0
    ? "Nothing"
    : entries.map(([currency, amount]) => formatMoney(amount, currency)).join(", ");
};

const billingView = (
  billing: BillingStateView,
  catalog: Option.Option<Catalog>,
  h: HtmlBuilder<Message>,
): Html =>
  card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [cardTitle(h, ["Plan"]), cardDescription(h, ["The plan this customer is billed on."])],
        ),
      ]),
      h.dl(
        [h.Class("pk-facts")],
        [
          h.div([], [h.dt([], ["Plan"]), h.dd([], [planLabelOf(catalog, billing.tier)])]),
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
          h.div([], [h.dt([], ["Billing interval"]), h.dd([], [billing.interval])]),
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
          h.div([], [h.dt([], ["Credits"]), h.dd([], [formatCredits(billing.credits)])]),
        ],
      ),
    ],
    { className: "pk-billing" },
  );

/**
 * The billing facts an operator checks after a payment failure or a tier
 * change: the scheduled terms, the last proration, and the recovery window.
 */
const adjustmentsView = (
  billing: BillingStateView,
  catalog: Option.Option<Catalog>,
  h: HtmlBuilder<Message>,
): Html => {
  const pending = billing.pendingTier;
  const proration = billing.proration;
  const catalogValue = Option.getOrNull(catalog);

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Adjustments"]),
            cardDescription(h, [
              "Scheduled terms, the last mid-cycle charge, and the payment-recovery window.",
            ]),
          ],
        ),
        billing.dunningAttempts === 0
          ? catalogBadge("No failed payments", "outline", h)
          : catalogBadge(
              `${formatCount(
                billing.dunningAttempts,
                billing.dunningAttempts === 1 ? "failed payment" : "failed payments",
              )}`,
              "warning",
              h,
            ),
      ]),
      h.dl(
        [h.Class("pk-facts")],
        [
          h.div([], [h.dt([], ["Failed payments"]), h.dd([], [String(billing.dunningAttempts)])]),
          h.div(
            [],
            [h.dt([], ["Trial ends"]), h.dd([], [formatOptionalDateTime(billing.trialEndsAt)])],
          ),
          h.div(
            [],
            [h.dt([], ["Access ends"]), h.dd([], [formatOptionalDateTime(billing.graceUntil)])],
          ),
          h.div(
            [],
            [
              h.dt([], ["Next top-up"]),
              h.dd([], [formatOptionalDateTime(billing.topUpCooldownUntil)]),
            ],
          ),
          // The last refill that could not be bought, cleared by the next
          // purchase. A page that shows the line and the cooldown but not the
          // refusal cannot tell a deferred crossing from a broken one.
          h.div(
            [],
            [
              h.dt([], ["Last top-up"]),
              h.dd(
                [],
                [
                  billing.topUpFailure === undefined
                    ? "—"
                    : `Refill refused by ${billing.topUpFailure.provider} (${billing.topUpFailure.reason}) at ${formatOptionalDateTime(billing.topUpFailure.at)}`,
                ],
              ),
            ],
          ),
          h.div([], [h.dt([], ["Billing timezone"]), h.dd([], [billing.anchorTz])]),
        ],
      ),
      h.div(
        [h.Class("pk-adjustment")],
        [
          h.h3([h.Class("pk-adjustment-title")], ["Scheduled plan change"]),
          pending === undefined
            ? h.p([h.Class("pk-muted")], ["No plan change is scheduled."])
            : h.div(
                [h.Class("pk-adjustment-body")],
                [
                  h.div(
                    [h.Class("pk-plan-meta")],
                    [
                      h.span(
                        [],
                        [
                          h.strong([], [planLabelOf(catalog, pending.tier)]),
                          ` scheduled for ${formatDateTime(billing.periodEnd)}`,
                        ],
                      ),
                      h.span(
                        [],
                        [
                          pending.price === undefined
                            ? "Free"
                            : `${formatMoney(pending.price.amount, pending.price.currency)} / ${pending.price.interval}`,
                        ],
                      ),
                      h.span(
                        [],
                        [
                          `${pending.credits.toLocaleString("en")} credits · ${
                            pending.creditsExpire === "never"
                              ? "never expire"
                              : "expire at period end"
                          }`,
                        ],
                      ),
                    ],
                  ),
                  ...(catalogValue === null
                    ? [
                        h.p(
                          [h.Class("pk-muted")],
                          ["Plans unavailable; included features cannot be shown."],
                        ),
                      ]
                    : [
                        grantsTable(
                          catalogValue,
                          Object.values(pending.allowances),
                          "Scheduled plan features",
                          h,
                        ),
                      ]),
                ],
              ),
        ],
      ),
      h.div(
        [h.Class("pk-adjustment")],
        [
          h.h3([h.Class("pk-adjustment-title")], ["Mid-cycle charge"]),
          proration === undefined
            ? h.p([h.Class("pk-muted")], ["No mid-cycle charge recorded for this customer."])
            : h.div(
                [h.Class("pk-adjustment-body")],
                [
                  prorationPanel(proration, h),
                  h.p(
                    [h.Class("pk-as-of")],
                    [
                      billing.prorationInvoice === undefined
                        ? "No invoice recorded yet."
                        : `Invoice ${billing.prorationInvoice}`,
                    ],
                  ),
                ],
              ),
        ],
      ),
    ],
    { className: "pk-adjustments" },
  );
};

const entitlementTerms = (
  entitlements: EntitlementsState,
  feature: EntitlementsState["features"][string],
): string => {
  if (feature.kind === "flag") return "—";
  const terms = [overageLabel(feature.overage)];

  if (feature.carried > 0) terms.push(`${formatCount(feature.carried, "carried")}`);

  if (feature.creditRates !== undefined) {
    const card = feature.creditRates;
    terms.push(
      `credits ${[
        `default: ${card.default}`,
        ...Object.entries(card.dimensions ?? {}).map(
          ([dimension, credits]) => `${dimension}: ${credits}`,
        ),
        ...(card.rules ?? []).map(
          (rule) =>
            `${
              Object.entries(rule.match)
                .map(([key, value]) => `${key}=${value}`)
                .join(",") || "any"
            }: ${rule.credits}`,
        ),
      ].join(" · ")}`,
    );
  }

  if (feature.cap !== undefined) terms.push(`cap ${formatCount(feature.cap, "units")}`);

  if (feature.unitPrice !== undefined)
    terms.push(`${formatMoney(feature.unitPrice.amount, feature.unitPrice.currency)} / unit`);

  if (feature.moneyCap !== undefined)
    terms.push(`${formatMoney(feature.moneyCap, entitlements.currency)} cap`);

  return terms.join(" · ");
};

const featureTable = (
  entitlements: EntitlementsState,
  catalog: Option.Option<Catalog>,
  h: HtmlBuilder<Message>,
): Html => {
  const entries = Object.entries(entitlements.features);

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Usage & limits"]),
            cardDescription(h, ["What this plan includes, what is left and when it resets."]),
          ],
        ),
        h.span(
          [h.Class("pk-count-pill")],
          [`${entries.length} ${entries.length === 1 ? "feature" : "features"}`],
        ),
      ]),
      entries.length === 0
        ? empty(h, {
            title: "No features on this plan yet.",
            description: "This customer has no features from its plan.",
          })
        : table(
            h,
            [
              tableHeader(h, [
                tableRow(h, [
                  tableHead(h, ["Feature"]),
                  tableHead(h, ["Included"]),
                  tableHead(h, ["Used / Pending"]),
                  tableHead(h, ["Left"]),
                  tableHead(h, ["Resets"]),
                  tableHead(h, ["Access"]),
                  tableHead(h, ["Terms"]),
                ]),
              ]),
              tableBody(
                h,
                entries.map(([name, feature]) => {
                  const kind = feature.kind ?? "metered";

                  return tableRow(
                    h,
                    [
                      tableCell(h, [
                        h.div(
                          [h.Class("pk-feature-cell")],
                          [
                            featureDisplay(catalog, name, h),
                            catalogBadge(
                              kindLabelOf(kind),
                              kind === "flag" ? "secondary" : "outline",
                              h,
                            ),
                          ],
                        ),
                      ]),
                      tableCell(h, [
                        kind === "flag"
                          ? "On/off"
                          : feature.creditRates !== undefined
                            ? "Credit pool"
                            : feature.included === null
                              ? "—"
                              : feature.included === "unlimited"
                                ? "Unlimited"
                                : feature.included.toLocaleString("en"),
                      ]),
                      tableCell(h, [
                        `${feature.used.toLocaleString("en")}${
                          feature.reserved === 0
                            ? ""
                            : ` / ${feature.reserved.toLocaleString("en")}`
                        }`,
                      ]),
                      tableCell(h, [
                        feature.remaining === null ? "—" : feature.remaining.toLocaleString("en"),
                      ]),
                      tableCell(h, [
                        feature.resetsAt === null ? "Never" : formatDate(feature.resetsAt),
                      ]),
                      tableCell(h, [
                        catalogBadge(
                          feature.allowed ? "Available" : "Suspended",
                          feature.allowed ? "success" : "destructive",
                          h,
                        ),
                      ]),
                      tableCell(h, [entitlementTerms(entitlements, feature)], {
                        className: "pk-feature-terms",
                      }),
                    ],
                    {
                      key: name,
                      attributes: [h.DataAttribute("paykit-feature", name)],
                    },
                  );
                }),
              ),
            ],
            { ariaLabel: "Usage and limits" },
          ),
    ],
    { className: "pk-allowances" },
  );
};

/** A point-in-time read's label: never claims to be live. */
const readLabel = (asOf: Option.Option<DateTime.Utc>, loading: boolean, live = false): string => {
  if (loading) return "Refreshing…";
  const value = Option.getOrUndefined(asOf);

  if (value === undefined) return "Updated · read time unknown";

  return `Updated ${formatDateTime(value)} · ${live ? "live reads follow" : "not live"}`;
};

/**
 * The holds the allowance table folded into `reserved` counts. A hold is an
 * entity with a deadline, and the operator's question is which ones are still
 * waiting.
 */
const refundsView = (billing: BillingStateView, h: HtmlBuilder<Message>): Html => {
  const refunds = Object.values(billing.refunds ?? {}).toSorted((left, right) =>
    left.refundId.localeCompare(right.refundId),
  );

  if (refunds.length === 0) return h.empty;

  const money =
    billing.charged === undefined && billing.refunded === undefined
      ? undefined
      : `Charged ${moneyByCurrency(billing.charged)} · refunded ${moneyByCurrency(billing.refunded)}.`;

  return card(h, [
    cardHeader(h, [
      h.div(
        [],
        [
          cardTitle(h, ["Refunds"]),
          cardDescription(h, [
            money === undefined
              ? "Money that went back. Reversing a refund restores the headroom it spent."
              : `${money} Reversing a refund restores the headroom it spent.`,
          ]),
        ],
      ),
    ]),
    table(
      h,
      [
        tableHeader(h, [
          tableRow(h, [
            tableHead(h, ["Refund"]),
            tableHead(h, ["Amount"]),
            tableHead(h, ["Returned"]),
            tableHead(h, ["Outstanding"]),
            tableHead(h, ["Reason"]),
            tableHead(h, [""]),
          ]),
        ]),
        tableBody(
          h,
          refunds.map((refund) => {
            const outstanding = outstandingRefundOf(refund);

            return tableRow(h, [
              tableCell(h, [refund.refundId], { className: "pk-account-id" }),
              tableCell(h, [formatMoney(refund.amount, refund.currency)]),
              tableCell(h, [formatMoney(refund.reversed ?? 0, refund.currency)]),
              tableCell(h, [formatMoney(outstanding, refund.currency)]),
              tableCell(h, [refund.reason ?? "—"]),
              // Offered only while the refund still has money to return: a
              // button that could only be refused is not offered.
              tableCell(h, [
                outstanding === 0
                  ? h.span([h.Class("pk-muted")], ["settled"])
                  : button(
                      "Reverse",
                      Message.ClickedReverseRefund({
                        refundId: refund.refundId,
                        outstanding,
                      }),
                      h,
                      { size: "sm" },
                    ),
              ]),
            ]);
          }),
        ),
      ],
      { className: "pk-refunds" },
    ),
  ]);
};

const holdsView = (account: AccountState, h: HtmlBuilder<Message>): Html => {
  if (Option.isNone(account.holds)) return h.empty;
  const holds = account.holds.value;
  const open = holds.holds.filter((hold) => hold.status === "open");
  const closed = holds.holds.filter((hold) => hold.status !== "open");
  const rows = [...open, ...closed];
  const asOf = Option.getOrUndefined(holds.asOf);

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Pending usage"]),
            cardDescription(h, ["Every reservation, including the ones that settled or released."]),
            h.p(
              [
                h.Class("pk-as-of"),
                h.DataAttribute(
                  "paykit-as-of",
                  asOf === undefined ? "unknown" : DateTime.formatIso(asOf),
                ),
              ],
              [readLabel(holds.asOf, holds.state === "Loading")],
            ),
          ],
        ),
        h.div(
          [h.Class("pk-badges")],
          [
            badge("holds", String(open.length), h),
            catalogBadge(`${closed.length} closed`, "secondary", h),
          ],
        ),
      ]),
      Option.match(holds.error, {
        onNone: () => h.empty,
        onSome: (error) =>
          alert(h, { variant: "destructive" }, [
            alertDescription(h, [`Could not load pending usage: ${error}`]),
          ]),
      }),
      rows.length === 0
        ? empty(h, {
            title: "No pending usage yet.",
            description:
              "A reservation appears from the moment it is taken until it settles or is released.",
          })
        : table(
            h,
            [
              tableHeader(h, [
                tableRow(h, [
                  tableHead(h, ["Status"]),
                  tableHead(h, ["Reservation"]),
                  tableHead(h, ["Feature"]),
                  tableHead(h, ["Amount"]),
                  tableHead(h, ["Terms"]),
                  tableHead(h, ["Started"]),
                  tableHead(h, ["Expires"]),
                ]),
              ]),
              tableBody(
                h,
                rows.map((hold) =>
                  tableRow(
                    h,
                    [
                      tableCell(h, [badge("hold", hold.status, h)]),
                      tableCell(h, [hold.id], { className: "pk-account-id" }),
                      tableCell(h, [
                        h.div(
                          [h.Class("pk-catalog-feature")],
                          [
                            h.span([h.Class("pk-catalog-feature-name")], [hold.feature]),
                            ...(hold.dimension === undefined
                              ? []
                              : [
                                  h.span(
                                    [h.Class("pk-catalog-feature-id")],
                                    [`dimension ${hold.dimension}`],
                                  ),
                                ]),
                          ],
                        ),
                      ]),
                      tableCell(h, [String(hold.amount)]),
                      tableCell(h, [
                        hold.rate === 0 && hold.cost === 0
                          ? "counted"
                          : `${hold.rate} rate · ${hold.cost} credits`,
                      ]),
                      tableCell(h, [formatDateTime(hold.at)]),
                      tableCell(h, [formatDateTime(hold.expiresAt)]),
                    ],
                    { key: hold.id },
                  ),
                ),
              ),
            ],
            { ariaLabel: "Pending usage" },
          ),
    ],
    {
      className: "pk-holds",
      attributes: [
        h.DataAttribute("paykit-holds", String(open.length)),
        h.DataAttribute("paykit-hold-history", String(rows.length)),
      ],
    },
  );
};

/**
 * The vendor ids the aggregate attached to this account, one group per
 * provider. The model never reads them; an operator uses them to find the
 * matching object in the provider's dashboard.
 */
const providerRefsView = (account: AccountState, h: HtmlBuilder<Message>): Html => {
  const current = Option.getOrNull(account.providerRefs);

  if (current === null) return h.empty;
  const entries = Object.entries(current.refs);
  const asOf = Option.getOrUndefined(current.asOf);

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Billing provider IDs"]),
            cardDescription(h, ["Reference IDs the billing provider attached to this customer."]),
            h.p(
              [
                h.Class("pk-as-of"),
                h.DataAttribute(
                  "paykit-as-of",
                  asOf === undefined ? "unknown" : DateTime.formatIso(asOf),
                ),
              ],
              [readLabel(current.asOf, current.state === "Loading")],
            ),
          ],
        ),
        catalogBadge(String(entries.length), entries.length === 0 ? "secondary" : "info", h),
      ]),
      Option.match(current.error, {
        onNone: () => h.empty,
        onSome: (error) =>
          alert(h, { variant: "destructive" }, [
            alertDescription(h, [`Could not load provider IDs: ${error}`]),
          ]),
      }),
      current.state === "Loading" && entries.length === 0
        ? h.p([h.Class("pk-muted")], ["Reading provider IDs…"])
        : entries.length === 0
          ? empty(h, {
              title: "No provider IDs.",
              description:
                "The provider attaches these when a checkout or subscription is recorded.",
            })
          : table(
              h,
              [
                tableHeader(h, [
                  tableRow(h, [
                    tableHead(h, ["Provider"]),
                    tableHead(h, ["Customer"]),
                    tableHead(h, ["Subscription"]),
                    tableHead(h, ["Checkout"]),
                  ]),
                ]),
                tableBody(
                  h,
                  entries.map(([provider, refs]) =>
                    tableRow(
                      h,
                      [
                        tableCell(h, [h.span([h.Class("pk-plan-name")], [provider])]),
                        tableCell(h, [refs.customer ?? "—"], { className: "pk-account-id" }),
                        tableCell(h, [refs.subscription ?? "—"], { className: "pk-account-id" }),
                        tableCell(h, [refs.checkout ?? "—"], { className: "pk-account-id" }),
                      ],
                      { key: provider },
                    ),
                  ),
                ),
              ],
              { ariaLabel: "Billing provider IDs" },
            ),
    ],
    {
      className: "pk-provider-refs",
      attributes: [h.DataAttribute("paykit-provider-refs", String(entries.length))],
    },
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
          h.p([h.Class("pk-muted")], ["Accepted. This change would record:"]),
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
                ? `Result: ${statusWordOf(state.status)} on ${planIdOf(state)}`
                : "Result: no plan",
            ],
          ),
        ],
      ),
    ),
    Match.tag("rejected", ({ rejection }) =>
      alert(h, { variant: "destructive" }, [
        alertDescription(h, ["That change would be rejected. Nothing was saved."]),
        h.details(
          [h.Class("pk-raw-detail")],
          [
            h.summary([], ["Technical detail"]),
            h.pre([h.Class("pk-failure")], [JSON.stringify(rejection, null, 2)]),
          ],
        ),
      ]),
    ),
    Match.tag("unpredictable", () =>
      h.p(
        [h.Class("pk-muted")],
        ["Only the server can decide this one. Send the change to see what happens."],
      ),
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
    onNone: (): ReadonlyArray<string> => [],
    onSome: (catalog) => catalog.tiers.map((entry) => entry.id),
  });

  const tier = Option.getOrElse(account.previewTier, () => "");

  const options = [
    { value: "", label: "Choose a plan" },
    ...tiers.map((value) => ({ value, label: planLabelOf(model.catalog, value) })),
  ];

  const preview = Option.getOrUndefined(account.preview);

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Preview change"]),
            h.p([h.Class("pk-muted")], ["See what would change. Nothing is saved."]),
          ],
        ),
        preview === undefined
          ? h.empty
          : button("Dismiss", Message.DismissedPreview(), h, { variant: "ghost" }),
      ]),
      selectField(
        "preview-tier",
        "Plan",
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
                  "Preview plan change",
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
        ? h.p([h.Class("pk-muted")], ["Pick a plan to preview a change or a subscribe."])
        : h.empty,
      preview === undefined ? h.empty : previewAnswerView(preview, h),
    ],
    { className: "pk-preview" },
  );
};

/** Judge the customer against the deploy: plans, prices and provider IDs. */
const verifyView = (account: AccountState, h: HtmlBuilder<Message>): Html =>
  card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Check sync"]),
            h.p(
              [h.Class("pk-muted")],
              ["Checks this customer against the plans and provider the deploy runs."],
            ),
          ],
        ),
        button("Check sync", Message.ClickedVerify(), h, { variant: "default" }),
      ]),
      Option.match(account.verify, {
        onNone: () => h.empty,
        onSome: (verify) =>
          verify.state === "Loading"
            ? h.p([h.Class("pk-muted")], ["Checking…"])
            : Option.isSome(verify.error)
              ? alert(h, { variant: "destructive" }, [
                  alertDescription(h, [`Check sync failed: ${verify.error.value}`]),
                ])
              : verify.mismatches.length === 0
                ? alert(h, { variant: "success" }, [
                    alertDescription(h, ["Everything matches the provider."]),
                  ])
                : h.ul(
                    [h.Class("pk-events")],
                    verify.mismatches.map((mismatch) =>
                      h.keyed("li")(
                        `${mismatch._tag}:${JSON.stringify(mismatch)}`,
                        [h.Class("pk-failure")],
                        [
                          h.p(
                            [],
                            [
                              mismatch._tag === "MissingProviderRef" ||
                              mismatch._tag === "TierHasNoPurchasePath"
                                ? "The checkout never completed for this customer."
                                : "A provider ID outlived the plan it described.",
                            ],
                          ),
                          h.details(
                            [h.Class("pk-raw-detail")],
                            [
                              h.summary([], ["Technical detail"]),
                              h.pre([], [JSON.stringify(mismatch, null, 2)]),
                            ],
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
  const primary = enabled.find((descriptor) => descriptor.action === "ChangeTier");
  const secondary = enabled.filter((descriptor) => descriptor.action !== "ChangeTier");

  return card(h, [
    cardHeader(h, [
      h.div(
        [],
        [
          cardTitle(h, ["Actions"]),
          cardDescription(h, [
            "Change the plan, or open another action. Every action is recorded against this customer.",
          ]),
        ],
      ),
    ]),
    enabled.length === 0
      ? empty(h, {
          title: "No actions available.",
          description: "This plan offers no action the console can send.",
        })
      : h.div(
          [h.Class("pk-actions")],
          [
            ...(primary === undefined
              ? []
              : [
                  button(
                    actionLabelOf(primary.action),
                    Message.ClickedAction({ action: primary.action }),
                    h,
                    { variant: "default" },
                  ),
                ]),
            ...(secondary.length === 0
              ? []
              : [
                  disclosure(
                    "More actions",
                    "",
                    [
                      h.div(
                        [h.Class("pk-actions")],
                        secondary.map((descriptor) =>
                          button(
                            actionLabelOf(descriptor.action),
                            Message.ClickedAction({ action: descriptor.action }),
                            h,
                          ),
                        ),
                      ),
                    ],
                    h,
                    "pk-more-actions",
                  ),
                ]),
          ],
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
  const fields = OperatorActions[draft.kind].fields;
  const tier = draft.values.tier ?? "";

  const changeQuote =
    draft.kind === "ChangeTier"
      ? Option.match(account.change, {
          onNone: () => Option.none(),
          onSome: (value) =>
            value.tier === tier && value._tag !== "Quoting" ? Option.some(value) : Option.none(),
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

  const tierOptions = (): ReadonlyArray<SelectOption> => {
    const currentTier = Option.match(account.billing, {
      onNone: () => undefined,
      onSome: (billing) => billing.tier,
    });

    return Option.match(model.catalog, {
      onNone: () => [{ value: "", label: "Choose a plan" }],
      onSome: (catalog) => [
        { value: "", label: "Choose a plan" },
        ...catalog.tiers
          .filter((entry) => entry.id !== currentTier)
          .map((entry) => ({
            value: entry.id,
            label: entry.name === undefined ? entry.id : `${entry.name} (${entry.id})`,
          })),
      ],
    });
  };

  // One control per field the action declared; the table is the form.
  const controls = (): ReadonlyArray<Html> => {
    if (fields.length === 0) {
      return [h.p([h.Class("pk-muted")], [`Send ${actionLabelOf(draft.kind)} for this customer?`])];
    }

    const rendered = fields.map((field): Html => {
      const value = draft.values[field.name] ?? "";
      const id = `draft-${field.name}`;

      switch (field.control) {
        case "tier":
          return selectField(id, field.label, value, tierOptions(), updated(field.name), h);
        case "number":
          return textField(id, field.label, value, updated(field.name), h, "number");
        case "datetime":
          return textField(id, field.label, value, updated(field.name), h, "datetime-local");
        case "text":
          return textField(id, field.label, value, updated(field.name), h);
      }
    });

    const quote =
      draft.kind === "ChangeTier"
        ? Option.match(changeQuote, {
            onNone: (): ReadonlyArray<Html> => [],
            onSome: (value) => [prorationPanel(value.proration, h)],
          })
        : [];

    return [...rendered, ...quote];
  };

  return card(
    h,
    [
      cardHeader(h, [cardTitle(h, [actionLabelOf(draft.kind)])]),
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
                    draft.kind === "ChangeTier" ? "Quote change" : "Send change",
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

const failureView = (failure: AdminFailure, h: HtmlBuilder<Message>): Html => {
  const detail = (title: string, value: unknown): Html =>
    h.details(
      [h.Class("pk-raw-detail")],
      [h.summary([], [title]), h.pre([h.Class("pk-failure")], [JSON.stringify(value, null, 2)])],
    );

  return Match.value(failure).pipe(
    Match.withReturnType<Html>(),
    Match.tag("Rejected", ({ rejection }) =>
      h.div(
        [h.Class("pk-failure-copy")],
        [
          h.p([], ["The server rejected this change. Nothing was saved."]),
          detail("Technical detail", rejection),
        ],
      ),
    ),
    Match.tag("Denied", ({ error }) =>
      h.div(
        [h.Class("pk-failure-copy")],
        [
          h.p([], ["The server refused this request. Sign in again and retry."]),
          detail("Technical detail", error),
        ],
      ),
    ),
    Match.tag("RpcRejected", ({ rejection }) =>
      h.div(
        [h.Class("pk-failure-copy")],
        [
          h.p([], ["The provider refused this refund. Nothing was saved."]),
          detail("Technical detail", rejection),
        ],
      ),
    ),
    Match.tag("Unknown", () => h.empty),
    Match.exhaustive,
  );
};

const pendingView = (pending: Pending, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Class("pk-pending"), h.DataAttribute("paykit-pending", pending.status)],
    [
      h.span([], [actionLabelOf(pending.intent.kind)]),
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

const eventVolumeView = (events: AccountState["events"], h: HtmlBuilder<Message>): Html => {
  if (events.length === 0) return h.empty;
  const hour = 60 * 60 * 1000;
  const newest = events.reduce((max, event) => Math.max(max, event.at.epochMilliseconds), 0);
  const start = newest - 24 * hour;
  const counts = Array.from({ length: 24 }, () => 0);

  for (const event of events) {
    const index = Math.min(
      23,
      Math.max(0, Math.floor((event.at.epochMilliseconds - start) / hour)),
    );

    counts[index] = (counts[index] ?? 0) + 1;
  }

  return h.div(
    [h.Class("pk-event-volume")],
    [
      h.div(
        [h.Class("pk-event-volume-head")],
        [
          h.span([], ["Event volume · last 24 hours"]),
          h.span([h.Class("pk-muted")], [`${events.length} loaded`]),
        ],
      ),
      miniBars(h, {
        values: counts,
        className: "pk-event-volume-bars",
        opacityRamp: true,
        label: "Event volume over the last 24 hours",
      }),
    ],
  );
};

const eventLogRow = (event: AccountState["events"][number], h: HtmlBuilder<Message>): Html =>
  h.keyed("details")(
    event.seq,
    [h.Class("pk-log-row"), h.DataAttribute("paykit-event", event.tag)],
    [
      h.summary(
        [h.Class("pk-log-summary")],
        [
          h.span([h.Class("pk-log-time")], [formatDateTime(event.at)]),
          h.code([h.Class("pk-log-tag")], [event.tag]),
          h.span([h.Class("pk-log-command")], [event.commandId]),
          h.span([h.Class("pk-log-chevron")], [icon(h, iconPaths.chevronRight)]),
        ],
      ),
      h.div([h.Class("pk-log-body")], [h.pre([], [event.body])]),
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
            cardTitle(h, ["Raw events"]),
            cardDescription(h, [
              "The complete event log, newest first. Open a row for its payload.",
            ]),
          ],
        ),
        badge("feed", account.feed, h),
      ]),
      eventVolumeView(account.events, h),
      Option.match(account.error, {
        onNone: () => h.empty,
        onSome: (error) => alert(h, { variant: "destructive" }, [alertDescription(h, [error])]),
      }),
      account.events.length === 0
        ? empty(h, {
            title: "Waiting for the first event.",
            description: "The customer's event stream fills this panel as it catches up.",
          })
        : h.div(
            [h.Class("pk-event-log pk-log-list"), h.Role("list")],
            account.events.map((event) => eventLogRow(event, h)),
          ),
    ],
    { className: "pk-event-card" },
  );

const timelineDetail = (entry: TimelineEntry, currency: string | undefined): string => {
  const parts: string[] = [];

  if (entry.feature !== undefined) parts.push(entry.feature);

  if (entry.tier !== undefined) parts.push(`plan ${entry.tier}`);

  if (entry.holdId !== undefined) parts.push(`reservation ${entry.holdId}`);

  if (entry.amount !== undefined) parts.push(formatCount(entry.amount, "units"));

  if (entry.credits !== undefined) parts.push(formatCredits(entry.credits));

  if (entry.charge !== undefined) parts.push(formatMoney(entry.charge, entry.currency ?? currency));

  if (entry.creditsAfter !== undefined) parts.push(`${formatCredits(entry.creditsAfter)} left`);

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

  const currency = Option.getOrUndefined(
    Option.firstSomeOf([
      Option.flatMap(account.entitlements, (value) => Option.fromNullishOr(value.currency)),
      Option.flatMap(account.billing, (value) => Option.fromNullishOr(value.currency)),
    ]),
  );

  const recent = timeline.entries.toReversed().slice(0, 50);

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Timeline"]),
            cardDescription(h, ["Billing history by period and feature."]),
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
                                tableHead(h, ["Pending"]),
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
                                      `${value.held} pending · ${value.settled} settled · ${value.released} released`,
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
            description:
              "Usage, pending reservations and credit moves appear here as the feed delivers them.",
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

const accountSummaryView = (model: Model, account: AccountState, h: HtmlBuilder<Message>): Html => {
  const billing = Option.getOrNull(account.billing);

  if (billing === null) {
    return h.div(
      [
        h.Class("pk-stats pk-stats-5"),
        h.DataAttribute("paykit-summary", "account"),
        h.AriaLabel("Customer summary"),
      ],
      [
        stat("Plan", "—", "Waiting for billing", "neutral", h),
        stat("Price", "—", "Waiting for billing", "neutral", h),
        stat("Credits", "—", "Waiting for billing", "neutral", h),
        stat("Usage", "—", "Waiting for billing", "neutral", h),
        stat("Next bill", "—", "Waiting for billing", "neutral", h),
      ],
    );
  }

  const usage = Option.match(account.entitlements, {
    onNone: () => undefined,
    onSome: (state) => usageSummaryOf(model.catalog, state.features, billing.credits),
  });

  const nextBill = nextBillOf(billing);

  return h.div(
    [
      h.Class("pk-stats pk-stats-5"),
      h.DataAttribute("paykit-summary", "account"),
      h.AriaLabel("Customer summary"),
    ],
    [
      stat("Plan", planLabelOf(model.catalog, billing.tier), billing.interval, "info", h),
      stat(
        "Price",
        billing.price === undefined
          ? "Free"
          : formatMoney(billing.price.amount, billing.price.currency),
        billing.price === undefined ? "No plan charge" : `Every ${billing.price.interval}`,
        "neutral",
        h,
      ),
      stat("Credits", formatCredits(billing.credits), "Available balance", "neutral", h),
      stat(
        "Usage",
        usage?.value ?? "—",
        usage?.detail ??
          (Option.isNone(account.entitlements) ? "Waiting for usage" : "No usage this period"),
        "neutral",
        h,
      ),
      stat(nextBill.label, nextBill.value, nextBill.detail, nextBill.tone, h),
    ],
  );
};

/** The payment problem, its count and its deadline, above everything else. */
const paymentIssueView = (billing: BillingStateView, h: HtmlBuilder<Message>): Html => {
  const standing = standingValueOf(billing.status);
  const isTerminal = billing.status === "canceled" || billing.status === "expired";
  const isBlocked = standing === "blocked" && !isTerminal;

  if (billing.status !== "grace" && !isBlocked) {
    return h.empty;
  }

  const failed =
    billing.dunningAttempts === 0
      ? undefined
      : `Payment failed ${
          billing.dunningAttempts === 1 ? "once" : `${billing.dunningAttempts} times`
        }`;

  return alert(
    h,
    {
      variant: isBlocked ? "destructive" : "warning",
      role: "status",
      className: "pk-payment-banner",
      attributes: [h.DataAttribute("paykit-banner", "payment")],
    },
    [
      alertTitle(h, [isBlocked ? "Access is suspended" : "Payment issue"]),
      alertDescription(h, [
        joinParts([
          isBlocked ? "Access is suspended" : undefined,
          failed,
          billing.graceUntil === undefined
            ? undefined
            : `access ends ${formatDate(billing.graceUntil)}`,
        ]),
      ]),
    ],
  );
};

const fact = (label: string, value: string, h: HtmlBuilder<Message>): Html =>
  h.div([], [h.dt([], [label]), h.dd([], [value])]);

/** The customer's own ceilings, thresholds and the alerts this period fired. */
const limitsView = (
  billing: BillingStateView,
  catalog: Option.Option<Catalog>,
  h: HtmlBuilder<Message>,
): Html => {
  const controls = billing.billingControls;
  const alerts = billing.alertsFired ?? [];

  if (controls === undefined && alerts.length === 0) return h.empty;

  const facts: Array<Html> = [];
  const autoTopUp = controls?.autoTopUp;

  if (autoTopUp !== undefined) {
    facts.push(
      fact(
        "Auto top-up",
        autoTopUp.enabled
          ? autoTopUp.threshold === undefined
            ? "On"
            : `On · below ${formatCredits(autoTopUp.threshold)}`
          : "Off",
        h,
      ),
    );
  }

  for (const limit of controls?.spendLimits ?? []) {
    facts.push(
      fact(
        `Spend limit · ${featureLabelOf(catalog, limit.featureId)}`,
        `${formatMoney(limit.amount, billing.currency)} per period`,
        h,
      ),
    );
  }

  const fired = new Set(alerts.map((alert) => `${alert.featureId}:${alert.at}`));

  for (const alert of controls?.usageAlerts ?? []) {
    if (fired.has(`${alert.featureId}:${alert.at}`)) continue;

    facts.push(
      fact(
        `Usage alert · ${featureLabelOf(catalog, alert.featureId)}`,
        `at ${formatCount(alert.at, "units")}`,
        h,
      ),
    );
  }

  if (facts.length === 0 && alerts.length === 0) return h.empty;

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Limits & alerts"]),
            cardDescription(h, ["The customer's own ceilings and thresholds."]),
          ],
        ),
      ]),
      ...(facts.length === 0 ? [] : [h.dl([h.Class("pk-facts")], facts)]),
      ...(alerts.length === 0
        ? []
        : [
            table(
              h,
              [
                tableHeader(h, [
                  tableRow(h, [
                    tableHead(h, ["Feature"]),
                    tableHead(h, ["Alert at"]),
                    tableHead(h, ["Usage after"]),
                    tableHead(h, ["Fired"]),
                  ]),
                ]),
                tableBody(
                  h,
                  alerts.map((alert) =>
                    tableRow(
                      h,
                      [
                        tableCell(h, [featureLabelOf(catalog, alert.featureId)]),
                        tableCell(h, [formatCount(alert.at, "units")]),
                        tableCell(h, [formatCount(alert.usedAfter, "units")]),
                        tableCell(h, [formatDateTime(alert.firedAt)]),
                      ],
                      { key: `${alert.featureId}:${alert.at}:${alert.firedAt.epochMilliseconds}` },
                    ),
                  ),
                ),
              ],
              { ariaLabel: "Alerts fired this period" },
            ),
          ]),
    ],
    {
      className: "pk-limits",
      attributes: [h.DataAttribute("paykit-limits", String(facts.length + alerts.length))],
    },
  );
};

/** The child scopes under this customer, archived ones included. */
const entitiesView = (billing: BillingStateView, h: HtmlBuilder<Message>): Html => {
  if (billing.entities.length === 0) return h.empty;

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Entities"]),
            cardDescription(h, ["The scopes under this customer, archived ones included."]),
          ],
        ),
        h.span([h.Class("pk-count-pill")], [String(billing.entities.length)]),
      ]),
      table(
        h,
        [
          tableHeader(h, [
            tableRow(h, [
              tableHead(h, ["Entity"]),
              tableHead(h, ["Status"]),
              tableHead(h, ["Created"]),
              tableHead(h, ["Archived"]),
            ]),
          ]),
          tableBody(
            h,
            billing.entities.map((entity) =>
              tableRow(
                h,
                [
                  tableCell(h, [
                    h.div(
                      [h.Class("pk-catalog-feature")],
                      [
                        h.span([h.Class("pk-catalog-feature-name")], [entity.name ?? entity.id]),
                        ...(entity.name === undefined
                          ? []
                          : [h.span([h.Class("pk-catalog-feature-id")], [entity.id])]),
                      ],
                    ),
                  ]),
                  tableCell(h, [
                    catalogBadge(
                      entity.status === "attached" ? "Attached" : "Archived",
                      entity.status === "attached" ? "success" : "secondary",
                      h,
                    ),
                  ]),
                  tableCell(h, [formatDate(entity.createdAt)]),
                  tableCell(h, [formatOptionalDate(entity.archivedAt)]),
                ],
                { key: entity.id },
              ),
            ),
          ),
        ],
        { ariaLabel: "Entities" },
      ),
    ],
    {
      className: "pk-entities",
      attributes: [h.DataAttribute("paykit-entities", String(billing.entities.length))],
    },
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
                  cardTitle(h, ["Pending changes"]),
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
                cardTitle(h, ["Plan"]),
                cardDescription(h, ["The plan this customer is billed on."]),
              ],
            ),
          ]),
          h.p([h.Class("pk-muted")], ["Waiting for the billing snapshot…"]),
        ],
        { className: "pk-billing" },
      ),
    onSome: (value) => billingView(value, model.catalog, h),
  });

  const allowancesPanel = Option.match(account.entitlements, {
    onNone: () => h.empty,
    onSome: (value) => featureTable(value, model.catalog, h),
  });

  const adjustmentsPanel = Option.match(account.billing, {
    onNone: () => h.empty,
    onSome: (value) => adjustmentsView(value, model.catalog, h),
  });

  const refundsPanel = Option.match(account.billing, {
    onNone: () => h.empty,
    onSome: (value) => refundsView(value, h),
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
      Option.match(account.billing, {
        onNone: () => h.empty,
        onSome: (value) => paymentIssueView(value, h),
      }),
      pending,
      accountSummaryView(model, account, h),
      section(
        "Overview",
        "Plan, usage and limits for this billing period.",
        [
          h.div([h.Class("pk-overview-grid")], [billingPanel, allowancesPanel]),
          Option.match(account.billing, {
            onNone: () => h.empty,
            onSome: (value) => limitsView(value, model.catalog, h),
          }),
          Option.match(account.billing, {
            onNone: () => h.empty,
            onSome: (value) => entitiesView(value, h),
          }),
          refundsPanel,
        ],
        h,
      ),
      section(
        "Actions",
        "Change the plan, or open another action.",
        [
          Option.match(account.draft, {
            onNone: () => actionButtons(account, model.catalog, h),
            onSome: (draft) => draftView(model, account, draft, h),
          }),
        ],
        h,
      ),
      section(
        "Activity",
        "The live feed and the billing history behind this period.",
        [timelineView(account, h)],
        h,
      ),
      disclosure(
        "Details",
        "Scheduled changes, billing provider IDs and pending usage.",
        [adjustmentsPanel, providerRefsView(account, h), holdsView(account, h), usagePanel],
        h,
        "pk-details-disclosure",
      ),
      disclosure(
        "Developer",
        "Preview a change, check sync and read raw events.",
        [previewView(model, account, h), verifyView(account, h), eventsView(account, h)],
        h,
        "pk-developer-disclosure",
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
            : "No account is open. Emitting opens the lab account below, seeds a plan, and records the event against it. Nothing here reaches the server.",
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
      ? `No account open · ${model.devTools.labRows.length} lab accounts`
      : `${account.id} · ${feedLabelOf(account.feed)} · ${account.events.length} events · ${
          Option.isSome(account.billing) ? "plan seeded" : "no plan"
        } · ${model.devTools.labRows.length} lab accounts`;

  const tierOptions = Option.match(model.catalog, {
    onNone: () => [{ value: model.devTools.seedTier, label: model.devTools.seedTier }],
    onSome: (catalog) =>
      catalog.tiers.map((tier) => ({
        value: String(tier.id),
        label: tier.name === undefined ? String(tier.id) : `${tier.name} (${tier.id})`,
      })),
  });

  const statusOptions = ["trialing", "active", "grace", "canceled", "expired"].map((value) => ({
    value,
    label: value,
  }));

  return h.div(
    [h.Class("pk-devtools-body")],
    [
      h.p(
        [h.Class("pk-devtools-note")],
        [
          "Seed an account with the terms you choose, or seed a varied set. Lab rows are local to this browser: they appear in the list and the dashboard overlay, never in the server projection.",
        ],
      ),
      h.div(
        [h.Class("pk-devtools-grid")],
        [
          textField(
            "devtools-account-id",
            "Account id",
            model.devTools.accountId,
            (value) => Message.UpdatedDevToolsAccountId({ value }),
            h,
          ),
          selectField(
            "devtools-seed-tier",
            "Plan",
            model.devTools.seedTier,
            tierOptions,
            (value) => Message.UpdatedDevToolsSeedTier({ value }),
            h,
          ),
          selectField(
            "devtools-seed-status",
            "Status",
            model.devTools.seedStatus,
            statusOptions,
            (value) => Message.UpdatedDevToolsSeedStatus({ value }),
            h,
          ),
          textField(
            "devtools-seed-credits",
            "Credits",
            model.devTools.seedCredits,
            (value) => Message.UpdatedDevToolsSeedCredits({ value }),
            h,
            "number",
          ),
          textField(
            "devtools-seed-usage",
            "Usage (first feature)",
            model.devTools.seedUsage,
            (value) => Message.UpdatedDevToolsSeedUsage({ value }),
            h,
            "number",
          ),
        ],
      ),
      h.div(
        [h.Class("pk-devtools-actions")],
        [
          button("Seed account", Message.ClickedSeedDevToolsSnapshot(), h, {
            variant: "default",
          }),
          button("Open account", Message.ClickedOpenDevToolsAccount(), h, {
            isDisabled: model.devTools.accountId.trim() === "",
          }),
          button("Seed 12 accounts", Message.ClickedSeedDevToolsAccounts(), h),
          button("Clear lab accounts", Message.ClickedClearDevToolsAccounts(), h, {
            isDisabled: model.devTools.labRows.length === 0,
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
          h.span([], [`feed: ${account === null ? "no account" : feedLabelOf(account.feed)}`]),
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

const countOfStatus = (overview: BillingOverview, status: string): number =>
  overview.byStatus.find((entry) => entry.status === status)?.count ?? 0;

const revenueTable = (overview: BillingOverview, h: HtmlBuilder<Message>): Html =>
  card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Revenue by currency"]),
            cardDescription(h, [
              "Estimated recurring revenue, grouped by the currency it is billed in.",
            ]),
          ],
        ),
      ]),
      table(
        h,
        [
          tableHeader(h, [
            tableRow(h, [
              tableHead(h, ["Currency"]),
              tableHead(h, ["Estimated MRR"]),
              tableHead(h, ["Estimated ARR"]),
              tableHead(h, ["In grace"]),
              tableHead(h, ["Trial pipeline"]),
            ]),
          ]),
          tableBody(
            h,
            overview.revenue.map((entry) =>
              tableRow(
                h,
                [
                  tableCell(h, [entry.currency.toUpperCase()]),
                  tableCell(h, [formatMoney(entry.mrr, entry.currency)]),
                  tableCell(h, [formatMoney(entry.arr, entry.currency)]),
                  tableCell(h, [formatMoney(entry.atRisk, entry.currency)]),
                  tableCell(h, [formatMoney(entry.trialPipeline, entry.currency)]),
                ],
                { key: entry.currency },
              ),
            ),
          ),
        ],
        { ariaLabel: "Revenue by currency" },
      ),
    ],
    { className: "pk-revenue" },
  );

/** The server-wide attention list the overview read carries. */
const attentionView = (
  overview: BillingOverview,
  catalog: Option.Option<Catalog>,
  h: HtmlBuilder<Message>,
): Html => {
  const rows = overview.attention ?? [];
  const count = overview.attentionCount ?? rows.length;
  const hasAttention = overview.attention !== undefined;
  const failedPayments = rows.reduce((total, row) => total + row.dunningAttempts, 0);

  return card(
    h,
    [
      cardHeader(h, [
        h.div(
          [],
          [
            cardTitle(h, ["Needs attention"]),
            cardDescription(h, [
              "Every customer in the deployment with a payment, access or usage issue.",
            ]),
          ],
        ),
        h.span([h.Class("pk-count-pill")], [hasAttention ? String(count) : "—"]),
      ]),
      rows.length === 0
        ? empty(h, {
            title: hasAttention ? "Nothing needs attention." : "Attention data is unavailable.",
            description: hasAttention
              ? "No customer in the deployment has an open issue."
              : "Refresh to load the customers that need attention.",
          })
        : table(
            h,
            [
              tableHeader(h, [
                tableRow(h, [
                  tableHead(h, ["Customer"]),
                  tableHead(h, ["Plan"]),
                  tableHead(h, ["Status"]),
                  tableHead(h, ["Reason"]),
                  tableHead(h, ["Failed payments"]),
                  tableHead(h, ["Next bill"]),
                ]),
              ]),
              tableBody(
                h,
                rows.map((row) =>
                  tableRow(
                    h,
                    [
                      tableCell(h, [row.account], { className: "pk-account-id" }),
                      tableCell(h, [planLabelOf(catalog, row.tier)]),
                      tableCell(h, [
                        statusPill(
                          statusSummaryOfFacts(
                            row.status,
                            row.standing,
                            row.reasons.includes("canceling"),
                          ),
                          row.status,
                          row.standing,
                          h,
                        ),
                      ]),
                      tableCell(
                        h,
                        [
                          row.reasons
                            .map((reason) => attentionReasonLabel(reason, row.dunningAttempts))
                            .join(" · "),
                        ],
                        { className: "pk-reason-cell" },
                      ),
                      tableCell(h, [row.dunningAttempts === 0 ? "—" : String(row.dunningAttempts)]),
                      tableCell(h, [formatDate(row.periodEnd)]),
                    ],
                    {
                      key: row.account,
                      className: "pk-row",
                      attributes: [
                        h.OnClick(Message.ClickedAccount({ account: AccountId.make(row.account) })),
                      ],
                    },
                  ),
                ),
              ),
            ],
            { ariaLabel: "Customers needing attention" },
          ),
      ...(count > rows.length
        ? [
            h.p(
              [h.Class("pk-as-of")],
              [`Showing the first ${rows.length} of ${count} customers who need attention.`],
            ),
          ]
        : []),
      ...(failedPayments === 0
        ? []
        : [
            h.p(
              [h.Class("pk-as-of")],
              [
                `${formatCount(
                  failedPayments,
                  failedPayments === 1 ? "failed payment" : "failed payments",
                )} on this list.`,
              ],
            ),
          ]),
    ],
    {
      className: "pk-attention",
      attributes: [h.DataAttribute("paykit-attention", String(count))],
    },
  );
};

/**
 * Add the lab's local rows to the server aggregate. The dashboard is the one
 * page where a devtools seed should be visible, and the server projection
 * never sees those rows. The attention list stays the server's: a lab row is
 * local to this browser and is not a deployment-wide fact.
 */
const mergeOverview = (
  base: BillingOverview,
  labRows: ReadonlyArray<BillingReadRow>,
  catalog: Option.Option<Catalog>,
): BillingOverview => {
  if (labRows.length === 0) return base;
  const status = new Map(base.byStatus.map((entry) => [entry.status, entry.count]));
  const standing = new Map(base.byStanding.map((entry) => [entry.standing, entry.count]));
  const tiers = new Map(base.byTier.map((entry) => [entry.tier, entry.count]));
  const revenue = new Map(base.revenue.map((entry) => [entry.currency, { ...entry }]));

  const priceOf = (row: BillingReadRow, currency: string | undefined) =>
    Option.match(catalog, {
      onNone: () => ({
        currency,
        monthly: 0,
      }),
      onSome: (value) => {
        const price = value.tiers.find((tier) => String(tier.id) === row.tier)?.price;

        return price === undefined
          ? { currency, monthly: 0 }
          : {
              currency: price.currency,
              monthly: price.interval === "annual" ? Math.round(price.amount / 12) : price.amount,
            };
      },
    });

  for (const row of labRows) {
    status.set(row.status, (status.get(row.status) ?? 0) + 1);
    standing.set(row.standing, (standing.get(row.standing) ?? 0) + 1);
    tiers.set(row.tier, (tiers.get(row.tier) ?? 0) + 1);
    const { currency, monthly } = priceOf(row, row.currency);

    if (currency === undefined || monthly === 0) continue;

    const entry = revenue.get(currency) ?? {
      currency,
      mrr: 0,
      arr: 0,
      trialPipeline: 0,
      atRisk: 0,
      churned: 0,
    };

    if (row.status === "active" || row.status === "grace") {
      entry.mrr += monthly;

      if (row.status === "grace") entry.atRisk += monthly;
    } else if (row.status === "trialing") {
      entry.trialPipeline += monthly;
    } else {
      entry.churned += monthly;
    }

    entry.arr = entry.mrr * 12;
    revenue.set(currency, entry);
  }

  return BillingOverview.make({
    asOf: base.asOf,
    accounts: base.accounts + labRows.length,
    byStatus: base.byStatus.map((entry) => ({
      status: entry.status,
      count: status.get(entry.status) ?? 0,
    })),
    byStanding: base.byStanding.map((entry) => ({
      standing: entry.standing,
      count: standing.get(entry.standing) ?? 0,
    })),
    byTier: [...tiers].map(([tier, count]) => ({ tier, count })),
    revenue: [...revenue.values()].toSorted((left, right) =>
      left.currency.localeCompare(right.currency),
    ),
    ...(base.attention === undefined ? {} : { attention: base.attention }),
    ...(base.attentionCount === undefined ? {} : { attentionCount: base.attentionCount }),
  });
};

const overviewView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const state = Option.getOrNull(model.overview);

  if (state === null) {
    return empty(h, {
      title: "Loading the overview…",
      description: "The dashboard aggregates every customer when it opens.",
    });
  }

  if (Option.isSome(state.error)) {
    return alert(h, { variant: "destructive" }, [
      alertDescription(h, [`Could not load the overview: ${state.error.value}`]),
    ]);
  }

  const serverOverview = Option.getOrNull(state.overview);

  if (serverOverview === null) {
    return empty(h, {
      title: "Loading the overview…",
      description: "The dashboard aggregates every customer when it opens.",
    });
  }

  const labRows = model.devTools.isEnabled ? model.devTools.labRows : [];
  const overview = mergeOverview(serverOverview, labRows, model.catalog);
  const primary = overview.revenue[0];
  const active = countOfStatus(overview, "active");
  const trialing = countOfStatus(overview, "trialing");
  const grace = countOfStatus(overview, "grace");
  const paying = active + grace;

  const attentionReported =
    overview.attention !== undefined || overview.attentionCount !== undefined;

  const attentionCount = overview.attentionCount ?? overview.attention?.length ?? 0;

  return h.div(
    [h.Class("pk-overview-page"), h.DataAttribute("paykit-overview", "dashboard")],
    [
      h.div(
        [h.Class("pk-stats")],
        [
          stat(
            "Estimated MRR",
            primary === undefined ? "—" : formatMoney(primary.mrr, primary.currency),
            primary === undefined ? "No priced customers" : `${paying} paying · list price`,
            "success",
            h,
          ),
          stat(
            "In grace",
            primary === undefined ? "—" : formatMoney(primary.atRisk, primary.currency),
            `${grace} in grace`,
            "warning",
            h,
          ),
          stat(
            "Trial pipeline",
            primary === undefined ? "—" : formatMoney(primary.trialPipeline, primary.currency),
            `${trialing} trialing`,
            "info",
            h,
          ),
          stat(
            "Needs attention",
            attentionReported ? String(attentionCount) : "—",
            attentionReported
              ? attentionCount === 0
                ? "Nothing open"
                : "Past due, suspended, canceling or limited"
              : "Unavailable",
            attentionReported && attentionCount > 0 ? "destructive" : "neutral",
            h,
          ),
        ],
      ),
      attentionView(overview, model.catalog, h),
      ...(overview.revenue.length > 1 ? [revenueTable(overview, h)] : []),
      h.p(
        [h.Class("pk-as-of")],
        [
          `Updated ${formatDateTime(overview.asOf)} · ${overview.accounts} customers${
            labRows.length === 0 ? "" : ` (${labRows.length} local lab, shown in the totals only)`
          }${attentionReported ? ` · ${attentionCount} need attention in the deployment` : ""}`,
        ],
      ),
    ],
  );
};

const pageBodyView = (model: Model, h: HtmlBuilder<Message>): Html => {
  switch (model.route._tag) {
    case "Overview":
      return overviewView(model, h);
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
                      `Plans unavailable: ${error}. Actions that need the plans are disabled.`,
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
