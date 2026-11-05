import type * as Domain from "@alchemy.run/domain";
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { AdminChangeTier, ChangeTierAnswer, ChangeTierRequest } from "./Admin/ChangeTier.ts";
import {
  AdminPreviewInput,
  AdminReadError,
  AdminReads,
  HoldsAnswer,
  PreviewAnswer,
} from "./Admin/Reads.ts";
import { BillingAdminApi } from "./BillingAdminApi.api.ts";
import { BillingReadPage, BillingReadQuery } from "./BillingReadStore.ts";
import { Catalog } from "./Catalog.ts";
import { VerifyMismatch } from "./Verify.ts";

/**
 * The Api-derived commands and live reads, exactly as
 * `@alchemy.run/domain/Foldkit` gives them for any Domain Api. Use this for
 * every write and every keyed read; the query Commands below cover only what
 * an Api cannot serve.
 *
 * ### Deriving the console's commands
 * **Example:** Send GrantCredits and follow an account
 * ```typescript
 * const allocation = DomainFoldkit.next(model.commandIds);
 * BillingAdmin.GrantCredits({
 *   target: model.account,
 *   input: { amount: 250 },
 *   commandId: allocation.commandId,
 * });
 * BillingAdmin.Entitlements.watch({ key: () => model.account, ... });
 * ```
 */
export const make = DomainFoldkit.make;
export const BillingAdmin = make(BillingAdminApi);

/** The Api client service the console's commands require at the runtime boundary. */
export type BillingAdminClient = Domain.Api.ClientKey<"BillingAdminApi">;

/** A stale read response carries the request it answers; drop it if it is old. */
export const QueryIds = Schema.Struct({ sent: Schema.Int });
export type QueryIds = typeof QueryIds.Type;

export const AdminQueryMessage = defineMessageUnion({
  SucceededListAccounts: { requestId: Schema.Int, page: BillingReadPage },
  FailedListAccounts: { requestId: Schema.Int, error: AdminReadError },
  SucceededPreview: { requestId: Schema.Int, answer: PreviewAnswer },
  FailedPreview: { requestId: Schema.Int, error: AdminReadError },
  SucceededVerify: { requestId: Schema.Int, mismatches: Schema.Array(VerifyMismatch) },
  FailedVerify: { requestId: Schema.Int, error: AdminReadError },
  SucceededGetCatalog: { requestId: Schema.Int, catalog: Catalog },
  FailedGetCatalog: { requestId: Schema.Int, error: AdminReadError },
  SucceededHolds: { requestId: Schema.Int, answer: HoldsAnswer },
  FailedHolds: { requestId: Schema.Int, error: AdminReadError },
});
export type AdminQueryMessage = typeof AdminQueryMessage.Type;

const withResult = <A>(
  effect: Effect.Effect<A, AdminReadError>,
  onSuccess: (value: A) => AdminQueryMessage,
  onFailure: (error: AdminReadError) => AdminQueryMessage,
): Effect.Effect<AdminQueryMessage> => effect.pipe(Effect.match({ onSuccess, onFailure }));

/**
 * One page of the cross-account `BillingRead` projection. A Command because a
 * list holds no live state and should refetch only when the operator asks or
 * the filters change.
 */
export const ListAccounts = Command.define("ListAccounts", {
  args: { requestId: Schema.Int, query: BillingReadQuery },
  messages: [AdminQueryMessage],
  execute: Effect.fn(function* ({ requestId, query }) {
    const reads = yield* AdminReads;
    return yield* withResult(
      reads.list(query),
      (page) => AdminQueryMessage.SucceededListAccounts({ requestId, page }),
      (error) => AdminQueryMessage.FailedListAccounts({ requestId, error }),
    );
  }),
});

/** Decide a command without recording it, for a preview-and-confirm flow. */
export const PreviewCommand = Command.define("PreviewCommand", {
  args: { requestId: Schema.Int, input: AdminPreviewInput },
  messages: [AdminQueryMessage],
  execute: Effect.fn(function* ({ requestId, input }) {
    const reads = yield* AdminReads;
    return yield* withResult(
      reads.preview(input),
      (answer) => AdminQueryMessage.SucceededPreview({ requestId, answer }),
      (error) => AdminQueryMessage.FailedPreview({ requestId, error }),
    );
  }),
});

/** Judge one account against the deploy's catalog and provider. */
export const VerifyAccount = Command.define("VerifyAccount", {
  args: { requestId: Schema.Int, account: Schema.String },
  messages: [AdminQueryMessage],
  execute: Effect.fn(function* ({ requestId, account }) {
    const reads = yield* AdminReads;
    return yield* withResult(
      reads.verify({ account }),
      (mismatches) => AdminQueryMessage.SucceededVerify({ requestId, mismatches }),
      (error) => AdminQueryMessage.FailedVerify({ requestId, error }),
    );
  }),
});

/**
 * One account's holds. The keyed views fold a hold into a `reserved` count, so
 * a console that needs the entity — its id, deadline and price — asks for it
 * here. One-shot: a hold changes when the account's events say it did.
 */
export const GetHolds = Command.define("GetHolds", {
  args: { requestId: Schema.Int, account: Schema.String },
  messages: [AdminQueryMessage],
  execute: Effect.fn(function* ({ requestId, account }) {
    const reads = yield* AdminReads;
    return yield* withResult(
      reads.holds(account),
      (answer) => AdminQueryMessage.SucceededHolds({ requestId, answer }),
      (error) => AdminQueryMessage.FailedHolds({ requestId, error }),
    );
  }),
});

/** The catalog the deployment validated, for tier choices and prices. */
export const GetCatalog = Command.define("GetCatalog", {
  args: { requestId: Schema.Int },
  messages: [AdminQueryMessage],
  execute: Effect.fn(function* ({ requestId }) {
    const reads = yield* AdminReads;
    return yield* withResult(
      reads.catalog(),
      (catalog) => AdminQueryMessage.SucceededGetCatalog({ requestId, catalog }),
      (error) => AdminQueryMessage.FailedGetCatalog({ requestId, error }),
    );
  }),
});

export const AdminChangeMessage = defineMessageUnion({
  SucceededChangeTier: { requestId: Schema.Int, answer: ChangeTierAnswer },
  FailedChangeTier: { requestId: Schema.Int, error: AdminReadError },
});
export type AdminChangeMessage = typeof AdminChangeMessage.Type;

/**
 * The server-side quote/apply flow for a tier change. Call it with no
 * `expected` to quote; call it with the quoted proration and a command id to
 * apply. A stale quote comes back as `requote`, never as a different charge.
 */
export const ApplyChangeTier = Command.define("ApplyChangeTier", {
  args: { requestId: Schema.Int, input: ChangeTierRequest },
  messages: [AdminChangeMessage],
  execute: Effect.fn(function* ({ requestId, input }) {
    const change = yield* AdminChangeTier;
    return yield* change.change(input).pipe(
      Effect.match({
        onSuccess: (answer) => AdminChangeMessage.SucceededChangeTier({ requestId, answer }),
        onFailure: (error) => AdminChangeMessage.FailedChangeTier({ requestId, error }),
      }),
    );
  }),
});

/** The write side of the console's server surface, separate from the query Commands. */
export const AdminChangeCommands = {
  Message: AdminChangeMessage,
  ChangeTier: ApplyChangeTier,
};

/** Every query Command, in one place, next to the Api-derived `BillingAdmin`. */
export const AdminQueries = {
  Message: AdminQueryMessage,
  ListAccounts,
  Preview: PreviewCommand,
  Verify: VerifyAccount,
  Holds: GetHolds,
  Catalog: GetCatalog,
};

export { CommandHeaders, CommandIds, next } from "@alchemy.run/domain/Foldkit";
export type { Failure, Snapshot } from "@alchemy.run/domain/Foldkit";
export { AdminAction, actionsFor } from "./AdminActions.ts";
export type { AdminActionDescriptor } from "./AdminActions.ts";
