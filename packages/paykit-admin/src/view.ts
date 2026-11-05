import { actionsFor } from "@potion.run/paykit/Admin";
import type { BillingReadRow } from "@potion.run/paykit/BillingReadStore";
import type { Catalog } from "@potion.run/paykit/Catalog";
import type { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import type { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import { AccountId } from "@potion.run/paykit/Subscription/Subscription.state";
import * as DateTime from "effect/DateTime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
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
  // A list is a point-in-time read, never a live view: say when it was read,
  // or say the read time is unknown. The panel never presents the rows as
  // current, because the account beside them is live and this is not.
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

  return h.section(
    [h.Class("pk-panel pk-accounts"), h.DataAttribute("paykit-consistency", "snapshot")],
    [
      h.div(
        [h.Class("pk-panel-head")],
        [
          h.div(
            [],
            [
              h.h2([], ["Accounts"]),
              h.p(
                [
                  h.Class("pk-muted pk-as-of"),
                  h.DataAttribute(
                    "paykit-as-of",
                    asOf === undefined ? "unknown" : DateTime.formatIso(asOf),
                  ),
                ],
                [asOfText],
              ),
            ],
          ),
          button("Refresh", Message.ClickedRefresh(), h),
        ],
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
      model.accounts.rows.length === 0
        ? model.accounts.state === "Loading"
          ? h.p([h.Class("pk-muted")], ["Loading accounts…"])
          : h.p([h.Class("pk-empty")], ["No accounts match these filters."])
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
  return h.section(
    [h.Class("pk-panel pk-holds"), h.DataAttribute("paykit-holds", String(open.length))],
    [
      h.div(
        [h.Class("pk-panel-head")],
        [
          h.div(
            [],
            [
              h.h2([], ["Open holds"]),
              h.p(
                [
                  h.Class("pk-muted pk-as-of"),
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
        ],
      ),
      Option.match(holds.error, {
        onNone: () => h.empty,
        onSome: (error) => h.p([h.Class("pk-error")], [`Could not load holds: ${error}`]),
      }),
      open.length === 0
        ? h.p(
            [h.Class("pk-muted")],
            [
              "No open holds. A hold appears from the moment it is taken until it settles or is released.",
            ],
          )
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
                          h.th([], ["Hold"]),
                          h.th([], ["Feature"]),
                          h.th([], ["Amount"]),
                          h.th([], ["Credits"]),
                          h.th([], ["Held at"]),
                          h.th([], ["Expires"]),
                        ],
                      ),
                    ],
                  ),
                  h.tbody(
                    [],
                    open.map((hold) =>
                      h.keyed("tr")(
                        hold.id,
                        [],
                        [
                          h.td([h.Class("pk-account-id")], [hold.id]),
                          h.td([], [hold.feature]),
                          h.td([], [String(hold.amount)]),
                          h.td([], [hold.cost === 0 ? "—" : `${hold.cost} credits`]),
                          h.td([], [formatDateTime(hold.at)]),
                          h.td([], [formatDateTime(hold.expiresAt)]),
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
  return h.section(
    [h.Class("pk-panel pk-usage")],
    [
      h.h2([], ["Usage this period"]),
      h.div(
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
                      h.th([], ["Recorded at"]),
                      h.th([], ["Billed"]),
                      h.th([], ["Ceiling"]),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                rows.map(({ feature, entry, priced }) =>
                  h.keyed("tr")(
                    feature,
                    [],
                    [
                      h.td([], [feature]),
                      h.td(
                        [],
                        [
                          priced.length === 0
                            ? "—"
                            : priced
                                .map(
                                  (units) =>
                                    `${units.quantity} @ ${formatMoney(units.unitPrice.amount, units.unitPrice.currency)}`,
                                )
                                .join(" · "),
                        ],
                      ),
                      h.td(
                        [],
                        [
                          entry.billed === undefined
                            ? "—"
                            : formatMoney(entry.billed, entitlements.currency),
                        ],
                      ),
                      h.td(
                        [],
                        [
                          [
                            entry.cap === undefined ? null : `${entry.cap} units`,
                            entry.moneyCap === undefined
                              ? null
                              : formatMoney(entry.moneyCap, entitlements.currency),
                          ]
                            .filter((part): part is string => part !== null)
                            .join(" / ") || "—",
                        ],
                      ),
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
};

const previewAnswerView = (preview: PreviewState, h: HtmlBuilder<Message>): Html => {
  if (preview.state === "Loading") return h.p([h.Class("pk-muted")], ["Asking the model…"]);
  if (Option.isSome(preview.error)) {
    return h.p([h.Class("pk-error")], [`Preview failed: ${preview.error.value}`]);
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
      h.div(
        [],
        [
          h.p([h.Class("pk-error")], [`Rejected: ${rejection._tag}`]),
          h.pre([h.Class("pk-failure")], [JSON.stringify(rejection, null, 2)]),
        ],
      ),
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
  return h.section(
    [h.Class("pk-panel pk-preview")],
    [
      h.div(
        [h.Class("pk-panel-head")],
        [
          h.div(
            [],
            [
              h.h2([], ["Ask the model"]),
              h.p(
                [h.Class("pk-muted")],
                ["Runs the same decision the write runs, and records nothing."],
              ),
            ],
          ),
          preview === undefined ? h.empty : button("Dismiss", Message.DismissedPreview(), h),
        ],
      ),
      h.div(
        [h.Class("pk-filters")],
        [select(tier, options, (value) => Message.UpdatedPreviewTier({ value }), h)],
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
  );
};

/** Judge the standing against the deploy: catalog, prices and provider refs. */
const verifyView = (account: AccountState, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("pk-panel pk-verify")],
    [
      h.div(
        [h.Class("pk-panel-head")],
        [
          h.div(
            [],
            [
              h.h2([], ["Verify"]),
              h.p(
                [h.Class("pk-muted")],
                ["Checks this standing against the catalog and provider the deploy runs."],
              ),
            ],
          ),
          button("Verify", Message.ClickedVerify(), h),
        ],
      ),
      Option.match(account.verify, {
        onNone: () => h.empty,
        onSome: (verify) =>
          verify.state === "Loading"
            ? h.p([h.Class("pk-muted")], ["Verifying…"])
            : Option.isSome(verify.error)
              ? h.p([h.Class("pk-error")], [`Verify failed: ${verify.error.value}`])
              : verify.mismatches.length === 0
                ? h.p([h.Class("pk-ok")], ["No drift: the catalog and provider agree."])
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
    ],
  );
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
      case "ChangeTier": {
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
          field("New tier", select(draft.tier, options, updated("tier"), h), h),
          ...Option.match(changeQuote, {
            onNone: () => [],
            onSome: (quote) => [prorationPanel(quote.proration, h)],
          }),
        ];
      }
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
          ...(isQuoted
            ? [button("Confirm charge", Message.ClickedConfirmChangeTier(), h)]
            : isApplying
              ? [h.span([h.Class("pk-muted")], ["Applying…"])]
              : [
                  button(
                    draft.kind === "ChangeTier" ? "Quote change" : "Send command",
                    Message.ClickedSubmitAction(),
                    h,
                  ),
                ]),
          button("Cancel", Message.ClickedCancelAction(), h),
        ],
      ),
    ],
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
        onSome: (draft) => draftView(model, account, draft, h),
      }),
      Option.match(account.billing, {
        onNone: () => h.p([h.Class("pk-muted")], ["Waiting for the billing snapshot…"]),
        onSome: (billing) => billingView(billing, h),
      }),
      Option.match(account.entitlements, {
        onNone: () => h.empty,
        onSome: (entitlements) => featureTable(entitlements, h),
      }),
      Option.match(account.entitlements, {
        onNone: () => h.empty,
        onSome: (entitlements) => usageView(entitlements, h),
      }),
      holdsView(account, h),
      previewView(model, account, h),
      verifyView(account, h),
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
