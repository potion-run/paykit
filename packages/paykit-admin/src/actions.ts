import { scheduleTierChangeInputOf } from "@potion.run/paykit";
import { AdminAction } from "@potion.run/paykit/Admin";
import { BillingAdmin } from "@potion.run/paykit/Foldkit";
import type { Catalog, AccountId } from "@potion.run/paykit/Read";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command } from "foldkit";
import { Message } from "./Message.ts";
import type { ConsoleResources } from "./Requirements.ts";

/**
 * One declaration per operator action.
 *
 * An action is the same thing in eight places today: the offered list, the
 * intent, the draft, its default, the field update, the parser, the form and the
 * command. This table is the one place they are declared together; the draft,
 * the form, the parser and the dispatcher derive from it, so adding an action is
 * adding a row — and the compiler refuses a row with a field it does not parse.
 *
 * The table is a `Record<AdminAction, …>`, so a new action in `AdminActions`
 * cannot land without a row here. `ChangeTier` is the one row without a `send`:
 * it is quoted before it is sent, and the quote/apply flow lives in `update.ts`.
 *
 * @internal
 */

/** A form field one action asks for, and the control it renders as. */
export interface ActionField {
  /** The key the parsed value is stored under, and the `UpdatedDraftField` name. */
  readonly name: string;
  readonly label: string;
  readonly control: "text" | "number" | "datetime" | "tier";
  /**
   * The value a new draft starts with. A function is evaluated against the
   * account, which is how the currency field starts on the standing's currency.
   */
  readonly default?: string | ((account: { readonly currency: string }) => string);
}

/** The command one action sends, as a Foldkit command carrying a Message. */
type AdminCommand = Command.Command<Message, never, ConsoleResources>;

/** Everything a row's `send` needs; `catalog` is only read by the tier rows. */
interface SendArgs<K extends AdminAction> {
  readonly target: AccountId;
  readonly intent: Extract<AdminIntent, { readonly kind: K }>;
  readonly commandId: string;
  readonly catalog: Catalog | null;
}

/** One action: the fields it asks for, how they parse, and the command it sends. */
export type ActionSpec<K extends AdminAction> = {
  readonly fields: ReadonlyArray<ActionField>;
  readonly parse: (
    values: Readonly<Record<string, string>>,
  ) => Result.Result<Extract<AdminIntent, { readonly kind: K }>, string>;
} & (K extends "ChangeTier"
  ? { readonly send?: undefined }
  : { readonly send: (args: SendArgs<K>) => AdminCommand });

/** The account and the action the form is open for. */
export const ActionDraft = Schema.Struct({
  kind: AdminAction,
  /** The form strings, keyed by `ActionField.name`. */
  values: Schema.Record(Schema.String, Schema.String),
});
export type ActionDraft = typeof ActionDraft.Type;

/** What the operator asked for, after parsing and before sending a command. */
export const AdminIntent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("GrantCredits"), amount: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("ExtendTrial"), trialEndsAt: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal("EnterGrace"), graceUntil: Schema.DateTimeUtc }),
  Schema.Struct({
    kind: Schema.Literal("RecordPayment"),
    amount: Schema.Int,
    currency: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("RecordPaymentFailure"),
    reason: Schema.String,
    graceUntil: Schema.DateTimeUtc,
  }),
  Schema.Struct({ kind: Schema.Literal("Recover") }),
  Schema.Struct({ kind: Schema.Literal("Expire") }),
  Schema.Struct({ kind: Schema.Literal("ScheduleCancellation") }),
  Schema.Struct({ kind: Schema.Literal("Resume") }),
  Schema.Struct({ kind: Schema.Literal("ChangeTier"), tier: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("ScheduleTierChange"), tier: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("WithdrawTierChange") }),
]);
export type AdminIntent = typeof AdminIntent.Type;

const wrap = (message: typeof BillingAdmin.Message.Type) =>
  Message.ReceivedAdminResult({ message });

const positiveInt = (value: string): Result.Result<number, string> => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Result.succeed(parsed)
    : Result.fail("Enter a positive whole amount in minor units.");
};

const nonEmpty = (value: string, label: string): Result.Result<string, string> =>
  value.trim() === "" ? Result.fail(`Enter a ${label}.`) : Result.succeed(value.trim());

const dateTime = (value: string, label: string): Result.Result<DateTime.Utc, string> => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? Result.fail(`Enter a valid ${label}.`)
    : Result.succeed(DateTime.fromDateUnsafe(parsed));
};

const selectTier = (value: string): Result.Result<string, string> => nonEmpty(value, "tier");

export const OperatorActions: { readonly [K in AdminAction]: ActionSpec<K> } = {
  GrantCredits: {
    fields: [{ name: "amount", label: "Amount (minor units)", control: "number" }],
    parse: (values) =>
      Result.map(positiveInt(values.amount ?? ""), (amount) => ({
        kind: "GrantCredits",
        amount,
      })),
    send: ({ target, intent, commandId }) =>
      Command.mapMessage(
        BillingAdmin.GrantCredits({ target, input: { amount: intent.amount }, commandId }),
        wrap,
      ),
  },
  ExtendTrial: {
    fields: [{ name: "trialEndsAt", label: "Trial ends", control: "datetime" }],
    parse: (values) =>
      Result.map(dateTime(values.trialEndsAt ?? "", "trial end"), (trialEndsAt) => ({
        kind: "ExtendTrial",
        trialEndsAt,
      })),
    send: ({ target, intent, commandId }) =>
      Command.mapMessage(
        BillingAdmin.ExtendTrial({
          target,
          input: { trialEndsAt: intent.trialEndsAt },
          commandId,
        }),
        wrap,
      ),
  },
  EnterGrace: {
    fields: [{ name: "graceUntil", label: "Grace deadline", control: "datetime" }],
    parse: (values) =>
      Result.map(dateTime(values.graceUntil ?? "", "grace deadline"), (graceUntil) => ({
        kind: "EnterGrace",
        graceUntil,
      })),
    send: ({ target, intent, commandId }) =>
      Command.mapMessage(
        BillingAdmin.EnterGrace({ target, input: { graceUntil: intent.graceUntil }, commandId }),
        wrap,
      ),
  },
  RecordPayment: {
    fields: [
      { name: "amount", label: "Amount (minor units)", control: "number" },
      {
        name: "currency",
        label: "Currency",
        control: "text",
        default: ({ currency }) => currency,
      },
    ],
    parse: (values) =>
      Result.flatMap(positiveInt(values.amount ?? ""), (amount) =>
        Result.map(nonEmpty(values.currency ?? "", "currency"), (currency) => ({
          kind: "RecordPayment",
          amount,
          currency,
        })),
      ),
    send: ({ target, intent, commandId }) =>
      Command.mapMessage(
        BillingAdmin.RecordPayment({
          target,
          input: { amount: intent.amount, currency: intent.currency },
          commandId,
        }),
        wrap,
      ),
  },
  RecordPaymentFailure: {
    fields: [
      { name: "reason", label: "Reason", control: "text" },
      { name: "graceUntil", label: "Grace deadline", control: "datetime" },
    ],
    parse: (values) =>
      Result.flatMap(nonEmpty(values.reason ?? "", "reason"), (reason) =>
        Result.map(dateTime(values.graceUntil ?? "", "grace deadline"), (graceUntil) => ({
          kind: "RecordPaymentFailure",
          reason,
          graceUntil,
        })),
      ),
    send: ({ target, intent, commandId }) =>
      Command.mapMessage(
        BillingAdmin.RecordPaymentFailure({
          target,
          input: { reason: intent.reason, graceUntil: intent.graceUntil },
          commandId,
        }),
        wrap,
      ),
  },
  Recover: {
    fields: [],
    parse: () => Result.succeed({ kind: "Recover" }),
    send: ({ target, commandId }) =>
      Command.mapMessage(BillingAdmin.Recover({ target, input: {}, commandId }), wrap),
  },
  Expire: {
    fields: [],
    parse: () => Result.succeed({ kind: "Expire" }),
    send: ({ target, commandId }) =>
      Command.mapMessage(BillingAdmin.Expire({ target, input: {}, commandId }), wrap),
  },
  ScheduleCancellation: {
    fields: [],
    parse: () => Result.succeed({ kind: "ScheduleCancellation" }),
    send: ({ target, commandId }) =>
      Command.mapMessage(BillingAdmin.ScheduleCancellation({ target, input: {}, commandId }), wrap),
  },
  Resume: {
    fields: [],
    parse: () => Result.succeed({ kind: "Resume" }),
    send: ({ target, commandId }) =>
      Command.mapMessage(BillingAdmin.Resume({ target, input: {}, commandId }), wrap),
  },
  WithdrawTierChange: {
    fields: [],
    parse: () => Result.succeed({ kind: "WithdrawTierChange" }),
    send: ({ target, commandId }) =>
      Command.mapMessage(BillingAdmin.WithdrawTierChange({ target, input: {}, commandId }), wrap),
  },
  ChangeTier: {
    fields: [{ name: "tier", label: "New tier", control: "tier" }],
    parse: (values) =>
      Result.map(selectTier(values.tier ?? ""), (tier) => ({ kind: "ChangeTier", tier })),
  },
  ScheduleTierChange: {
    fields: [{ name: "tier", label: "New tier", control: "tier" }],
    parse: (values) =>
      Result.map(selectTier(values.tier ?? ""), (tier) => ({ kind: "ScheduleTierChange", tier })),
    send: ({ target, intent, commandId, catalog }) => {
      // No catalog, or no such tier: send an empty grant so the model answers
      // `TierNotInCatalog` instead of the console guessing.
      const input = catalog === null ? null : scheduleTierChangeInputOf(catalog, intent.tier);
      return Command.mapMessage(
        BillingAdmin.ScheduleTierChange({
          target,
          input: input ?? {
            tier: intent.tier,
            allowances: {},
            credits: 0,
            creditsExpire: "period",
            rates: {},
          },
          commandId,
        }),
        wrap,
      );
    },
  },
};

/** The values a new draft starts with, from the table's fields. */
export const draftFor = (
  kind: AdminAction,
  billing: Option.Option<{ readonly currency?: string }>,
): ActionDraft => {
  const currency = Option.match(billing, {
    onNone: () => "usd",
    onSome: (state) => state.currency ?? "usd",
  });
  const values = Object.fromEntries(
    OperatorActions[kind].fields.map((field) => [
      field.name,
      field.default === undefined
        ? ""
        : typeof field.default === "function"
          ? field.default({ currency })
          : field.default,
    ]),
  );
  return { kind, values };
};

/**
 * Parse a draft with the row that declared it. The switch is what narrows
 * `draft.kind` to the row's member; the parsing itself is the row's.
 */
export const parseDraft = (draft: ActionDraft): Result.Result<AdminIntent, string> => {
  switch (draft.kind) {
    case "GrantCredits":
      return OperatorActions.GrantCredits.parse(draft.values);
    case "ExtendTrial":
      return OperatorActions.ExtendTrial.parse(draft.values);
    case "EnterGrace":
      return OperatorActions.EnterGrace.parse(draft.values);
    case "RecordPayment":
      return OperatorActions.RecordPayment.parse(draft.values);
    case "RecordPaymentFailure":
      return OperatorActions.RecordPaymentFailure.parse(draft.values);
    case "Recover":
      return OperatorActions.Recover.parse(draft.values);
    case "Expire":
      return OperatorActions.Expire.parse(draft.values);
    case "ScheduleCancellation":
      return OperatorActions.ScheduleCancellation.parse(draft.values);
    case "Resume":
      return OperatorActions.Resume.parse(draft.values);
    case "WithdrawTierChange":
      return OperatorActions.WithdrawTierChange.parse(draft.values);
    case "ChangeTier":
      return OperatorActions.ChangeTier.parse(draft.values);
    case "ScheduleTierChange":
      return OperatorActions.ScheduleTierChange.parse(draft.values);
  }
};

/** Set one field, ignoring a name the open action does not ask for. */
export const updatedDraft = (draft: ActionDraft, field: string, value: string): ActionDraft => {
  const known = OperatorActions[draft.kind].fields.some((entry) => entry.name === field);
  return known ? { ...draft, values: { ...draft.values, [field]: value } } : draft;
};
