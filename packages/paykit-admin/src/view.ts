import { AccountId, type BillingReadRow, type Catalog } from "@potion.run/paykit";
import { actionsFor } from "@potion.run/paykit/Admin";
import type { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import type { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import * as Option from "effect/Option";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { formatDateTime, formatMoney, formatOptionalDateTime } from "./format.ts";
import { Message } from "./Message.ts";
import {
  type AccountState,
  type ActionDraft,
  ConsoleAction,
  type Model,
  type Pending,
} from "./Model.ts";

const button = (label: string, message: Message, h: HtmlBuilder<Message>) =>
  h.button([h.Type("button"), h.OnClick(message), h.Class("pk-button")], [label]);

const dangerButton = (label: string, message: Message, h: HtmlBuilder<Message>) =>
  h.button([h.Type("button"), h.OnClick(message), h.Class("pk-button pk-button-danger")], [label]);

const badge = (kind: string, value: string, h: HtmlBuilder<Message>) =>
  h.span([h.Class(`pk-badge pk-badge-${kind}`), h.DataAttribute(`paykit-${kind}`, value)], [value]);

const field = (label: string, control: Html, h: HtmlBuilder<Message>): Html =>
  h.label([h.Class("pk-field")], [h.span([h.Class("pk-field-label")], [label]), control]);

const textInput = (
  value: string,
  onInput: (value: string) => Message,
  h: HtmlBuilder<Message>,
  type = "text",
): Html =>
  h.input([
    h.Type(type),
    h.Value(value),
    h.OnInput(onInput),
    h.Class("pk-input"),
    ...(type === "number" ? [h.Min("1"), h.Step("1")] : []),
  ]);

const select = (
  value: string,
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  onInput: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.select(
    [h.Value(value), h.OnInput(onInput), h.Class("pk-select")],
    options.map((option) =>
      h.option([h.Value(option.value), h.Selected(option.value === value)], [option.label]),
    ),
  );

const filterOptions = (
  values: ReadonlyArray<string>,
  allLabel: string,
): ReadonlyArray<{ readonly value: string; readonly label: string }> => [
  { value: "", label: allLabel },
  ...values.map((value) => ({ value, label: value })),
];

const accountsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const filter = model.accounts.filter;
  const standing = Option.getOrElse(filter.standing, () => "");
  const status = Option.getOrElse(filter.status, () => "");
  const tier = Option.getOrElse(filter.tier, () => "");
  const tierOptions = Option.match(model.catalog, {
    onNone: () => [{ value: "", label: "All tiers" }],
    onSome: (catalog: Catalog) =>
      filterOptions(
        catalog.tiers.map((entry) => entry.id),
        "All tiers",
      ),
  });

  return h.section(
    [h.Class("pk-panel pk-accounts")],
    [
      h.div(
        [h.Class("pk-panel-head")],
        [h.h2([], ["Accounts"]), button("Refresh", Message.ClickedRefresh(), h)],
      ),
      h.div(
        [h.Class("pk-filters")],
        [
          select(
            standing,
            filterOptions(["good", "grace", "blocked"], "All standings"),
            (value) => Message.UpdatedStandingFilter({ value }),
            h,
          ),
          select(
            status,
            filterOptions(["trialing", "active", "grace", "canceled", "expired"], "All statuses"),
            (value) => Message.UpdatedStatusFilter({ value }),
            h,
          ),
          select(tier, tierOptions, (value) => Message.UpdatedTierFilter({ value }), h),
        ],
      ),
      Option.match(model.accounts.error, {
        onNone: () => h.empty,
        onSome: (error) => h.p([h.Class("pk-error")], [`Could not load accounts: ${error}`]),
      }),
      model.accounts.state === "Loading"
        ? h.p([h.Class("pk-muted")], ["Loading accounts…"])
        : model.accounts.rows.length === 0
          ? h.p([h.Class("pk-empty")], ["No accounts match these filters."])
          : h.div(
              [h.Class("pk-table-wrap")],
              [
                h.table(
                  [h.Class("pk-table")],
                  [
                    h.thead(
                      [],
                      [
                        h.tr(
                          [],
                          [
                            h.th([], ["Account"]),
                            h.th([], ["Tier"]),
                            h.th([], ["Standing"]),
                            h.th([], ["Status"]),
                            h.th([], ["Period end"]),
                          ],
                        ),
                      ],
                    ),
                    h.tbody(
                      [],
                      model.accounts.rows.map((row: BillingReadRow) =>
                        h.keyed("tr")(
                          row.account,
                          [
                            h.Class("pk-row"),
                            h.OnClick(
                              Message.ClickedAccount({ account: AccountId.make(row.account) }),
                            ),
                          ],
                          [
                            h.td([h.Class("pk-account-id")], [row.account]),
                            h.td([], [row.tier]),
                            h.td([], [badge("standing", row.standing, h)]),
                            h.td([], [badge("status", row.status, h)]),
                            h.td([], [formatDateTime(row.periodEnd)]),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
      Option.match(model.accounts.next, {
        onNone: () => h.empty,
        onSome: () => button("Next page", Message.ClickedNextPage(), h),
      }),
    ],
  );
};

const billingView = (billing: BillingStateView, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("pk-panel")],
    [
      h.div(
        [h.Class("pk-panel-head")],
        [
          h.h2([], ["Standing"]),
          h.div(
            [h.Class("pk-badges")],
            [
              badge("status", billing.status, h),
              badge(
                "standing",
                billing.status === "grace"
                  ? "grace"
                  : billing.status === "active" || billing.status === "trialing"
                    ? "good"
                    : "blocked",
                h,
              ),
            ],
          ),
        ],
      ),
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
  );

const featureTable = (entitlements: EntitlementsState, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("pk-panel")],
    [
      h.h2([], ["Allowances"]),
      Object.keys(entitlements.features).length === 0
        ? h.p([h.Class("pk-muted")], ["This account has no allowances yet."])
        : h.div(
            [h.Class("pk-table-wrap")],
            [
              h.table(
                [h.Class("pk-table")],
                [
                  h.thead(
                    [],
                    [
                      h.tr(
                        [],
                        [
                          h.th([], ["Feature"]),
                          h.th([], ["Included"]),
                          h.th([], ["Used"]),
                          h.th([], ["Reserved"]),
                          h.th([], ["Remaining"]),
                          h.th([], ["Overage"]),
                          h.th([], ["Resets"]),
                        ],
                      ),
                    ],
                  ),
                  h.tbody(
                    [],
                    Object.entries(entitlements.features).map(([name, feature]) =>
                      h.keyed("tr")(
                        name,
                        [],
                        [
                          h.td([], [name]),
                          h.td([], [String(feature.included)]),
                          h.td([], [String(feature.used)]),
                          h.td([], [String(feature.reserved)]),
                          h.td([], [String(feature.remaining)]),
                          h.td([], [feature.overage]),
                          h.td([], [feature.resets]),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
    ],
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
  const changeTier = descriptors.find((descriptor) => descriptor.action === "ChangeTier");

  return h.section(
    [h.Class("pk-panel")],
    [
      h.h2([], ["Actions"]),
      enabled.length === 0
        ? h.p([h.Class("pk-muted")], ["No operator actions for this standing."])
        : h.div(
            [h.Class("pk-actions")],
            enabled.map((descriptor) =>
              button(descriptor.action, Message.ClickedAction({ action: descriptor.action }), h),
            ),
          ),
      changeTier === undefined
        ? h.empty
        : h.p(
            [h.Class("pk-muted")],
            [
              "Tier changes are not enabled here yet: they need a server-applied proration quote so the amount the operator confirms is the amount the log records.",
            ],
          ),
    ],
  );
};

const draftView = (draft: ActionDraft, h: HtmlBuilder<Message>): Html => {
  const updated = (field: string) => (value: string) => Message.UpdatedDraftField({ field, value });

  const controls = (): ReadonlyArray<Html> => {
    switch (draft.kind) {
      case "GrantCredits":
        return [
          field("Amount (minor units)", textInput(draft.amount, updated("amount"), h, "number"), h),
        ];
      case "ExtendTrial":
        return [
          field(
            "Trial ends",
            textInput(draft.trialEndsAt, updated("trialEndsAt"), h, "datetime-local"),
            h,
          ),
        ];
      case "EnterGrace":
        return [
          field(
            "Grace deadline",
            textInput(draft.graceUntil, updated("graceUntil"), h, "datetime-local"),
            h,
          ),
        ];
      case "RecordPayment":
        return [
          field("Amount (minor units)", textInput(draft.amount, updated("amount"), h, "number"), h),
          field("Currency", textInput(draft.currency, updated("currency"), h), h),
        ];
      case "RecordPaymentFailure":
        return [
          field("Reason", textInput(draft.reason, updated("reason"), h), h),
          field(
            "Grace deadline",
            textInput(draft.graceUntil, updated("graceUntil"), h, "datetime-local"),
            h,
          ),
        ];
      case "Recover":
      case "Expire":
      case "ScheduleCancellation":
      case "Resume":
        return [h.p([h.Class("pk-muted")], [`Send ${draft.kind} for this account?`])];
    }
  };

  return h.section(
    [h.Class("pk-panel pk-draft")],
    [
      h.h2([], [draft.kind]),
      ...controls(),
      h.div(
        [h.Class("pk-actions")],
        [
          button("Send command", Message.ClickedSubmitAction(), h),
          button("Cancel", Message.ClickedCancelAction(), h),
        ],
      ),
    ],
  );
};

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
      pending.status === "Unknown"
        ? button("Retry", Message.ClickedRetryPending({ commandId: pending.commandId }), h)
        : h.empty,
    ],
  );

const eventsView = (account: AccountState, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("pk-panel")],
    [
      h.div([h.Class("pk-panel-head")], [h.h2([], ["Events"]), badge("feed", account.feed, h)]),
      Option.match(account.error, {
        onNone: () => h.empty,
        onSome: (error) => h.p([h.Class("pk-error")], [error]),
      }),
      account.events.length === 0
        ? h.p([h.Class("pk-muted")], ["Waiting for the first event…"])
        : h.ol(
            [h.Class("pk-events")],
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
  );

const accountView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (Option.isNone(model.account)) {
    return h.section(
      [h.Class("pk-panel pk-empty")],
      [
        h.h2([], ["No account open"]),
        h.p(
          [],
          ["Pick an account from the list to inspect its standing, allowances and event log."],
        ),
      ],
    );
  }

  const account = model.account.value;
  return h.section(
    [h.Class("pk-account")],
    [
      h.div(
        [h.Class("pk-panel-head")],
        [h.h2([], [account.id]), dangerButton("Close", Message.ClosedAccount(), h)],
      ),
      Option.match(account.notice, {
        onNone: () => h.empty,
        onSome: (notice) =>
          h.div(
            [h.Class("pk-notice"), h.AriaLive("polite")],
            [notice, button("Dismiss", Message.DismissedNotice(), h)],
          ),
      }),
      account.pending.length === 0
        ? h.empty
        : h.section(
            [h.Class("pk-panel")],
            [
              h.h2([], ["Pending commands"]),
              h.ul(
                [h.Class("pk-pending-list")],
                account.pending.map((pending) => pendingView(pending, h)),
              ),
            ],
          ),
      Option.match(account.draft, {
        onNone: () => actionButtons(account, model.catalog, h),
        onSome: (draft) => draftView(draft, h),
      }),
      Option.match(account.billing, {
        onNone: () => h.p([h.Class("pk-muted")], ["Waiting for the billing snapshot…"]),
        onSome: (billing) => billingView(billing, h),
      }),
      Option.match(account.entitlements, {
        onNone: () => h.empty,
        onSome: (entitlements) => featureTable(entitlements, h),
      }),
      eventsView(account, h),
    ],
  );
};

/** The console's single page: accounts on the left, the open account on the right. */
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Paykit admin",
  body: h.div(
    [h.Class("pk-admin")],
    [
      h.header(
        [h.Class("pk-header")],
        [
          h.div(
            [],
            [
              h.h1([], ["Paykit admin"]),
              h.p([h.Class("pk-muted")], ["Billing and entitlement operations"]),
            ],
          ),
          Option.match(model.actor, {
            onNone: () => h.span([h.Class("pk-muted")], ["No actor seeded"]),
            onSome: (actor) => h.span([h.Class("pk-muted")], [`${actor.kind}: ${actor.id}`]),
          }),
        ],
      ),
      Option.match(model.catalogError, {
        onNone: () => h.empty,
        onSome: (error) =>
          h.p(
            [h.Class("pk-error")],
            [`Catalog unavailable: ${error}. Actions that need the catalog are disabled.`],
          ),
      }),
      h.main([h.Class("pk-main")], [accountsView(model, h), accountView(model, h)]),
    ],
  ),
});
