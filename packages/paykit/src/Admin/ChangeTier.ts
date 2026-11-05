import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";
import { asSystem } from "../Auth/Actor.ts";
import { Admin } from "../Auth/Guards.ts";
import { tierTermsOf } from "../Catalog.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CatalogService } from "../CatalogService.ts";
import { Proration, sameProration } from "../Proration.ts";
import {
  DowngradeBelowCeiling,
  DowngradeBelowSpend,
  DowngradeBelowUsage,
} from "../Subscription/ChangeTier.command.ts";
import { planChangeTier } from "../Subscription/ChangeTier.plan.ts";
import { CurrencyMismatch } from "../Subscription/CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { ProrationMismatch } from "../Subscription/ProrationMismatch.rejection.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import { TierNotInCatalog } from "../Subscription/TierNotInCatalog.rejection.ts";
import { AdminReadError, AdminReadFailed, AdminReadsRpcs } from "./Reads.ts";

/** A tier change the console asks the server to quote or apply. */
export const ChangeTierRequest = Schema.Struct({
  account: Schema.String,
  tier: Schema.String,
  /**
   * The proration the operator saw. Omit it to quote without applying. On
   * apply, the server recomputes and refuses to move a different amount; a
   * mismatch returns a `requote` instead of charging it.
   */
  expected: Schema.optionalKey(Schema.NullOr(Proration)),
  /** The idempotency key for an apply. The server allocates one when absent. */
  commandId: Schema.optionalKey(Schema.String),
});
export type ChangeTierRequest = typeof ChangeTierRequest.Type;

/** Every typed refusal a tier change can return as data. */
export const ChangeTierRejection = Schema.Union([
  TierNotInCatalog,
  NotSubscribed,
  CurrencyMismatch,
  DowngradeBelowUsage,
  DowngradeBelowSpend,
  DowngradeBelowCeiling,
  ProrationMismatch,
  CatalogMismatch,
]);
export type ChangeTierRejection = typeof ChangeTierRejection.Type;

/** The current quote. No command was sent. */
export const ChangeTierQuoted = Schema.TaggedStruct("quoted", {
  tier: Schema.String,
  proration: Schema.NullOr(Proration),
});

/** The amount moved between quote and apply; confirm the new one. */
export const ChangeTierRequote = Schema.TaggedStruct("requote", {
  tier: Schema.String,
  proration: Schema.NullOr(Proration),
});

/** The command committed. `proration` is exactly what the event records. */
export const ChangeTierApplied = Schema.TaggedStruct("applied", {
  commandId: Schema.String,
  tier: Schema.String,
  proration: Schema.NullOr(Proration),
  stream: Schema.String,
  version: Schema.Int,
});

/** The model refused the change. */
export const ChangeTierRejected = Schema.TaggedStruct("rejected", {
  commandId: Schema.optionalKey(Schema.String),
  rejection: ChangeTierRejection,
});

/** A refusal the console could not classify. */
export const ChangeTierFailed = Schema.TaggedStruct("failed", {
  commandId: Schema.optionalKey(Schema.String),
  reason: Schema.String,
});

export const ChangeTierAnswer = Schema.Union([
  ChangeTierQuoted,
  ChangeTierRequote,
  ChangeTierApplied,
  ChangeTierRejected,
  ChangeTierFailed,
]);
export type ChangeTierAnswer = typeof ChangeTierAnswer.Type;

/** The server-side tier change: quote first, apply the amount that was shown. */
export interface AdminChangeTierShape {
  readonly change: (input: ChangeTierRequest) => Effect.Effect<ChangeTierAnswer, AdminReadError>;
}

/**
 * A catalog-owning `ChangeTier` sender. The aggregate's `decide` cannot look up
 * a price, and a client cannot reliably compute the proration at the instant
 * the server decides it. This binding builds the command from the catalog,
 * computes the proration with the server clock, and applies only when the
 * amount matches what the operator confirmed. A mismatch is a `requote`, never
 * a silently different charge.
 *
 * @primitive
 */
export class AdminChangeTier extends Context.Service<AdminChangeTier, AdminChangeTierShape>()(
  "paykit/AdminChangeTier",
) {}

export const makeAdminChangeTier = Effect.gen(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;

  return {
    change: (input) =>
      Effect.gen(function* () {
        const terms = tierTermsOf(catalog, input.tier);
        if (terms === null || terms.kind === "one_off") {
          return ChangeTierRejected.make({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            rejection: new TierNotInCatalog({ tier: input.tier }),
          });
        }

        const ref = Subscription.ref(input.account);
        const state = yield* subscription.state(ref);
        if (state._tag !== "Subscribed") {
          return ChangeTierRejected.make({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            rejection: new NotSubscribed({ account: input.account }),
          });
        }

        const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
        const plan = planChangeTier(catalog, input.tier, state, now);
        if (plan === null) {
          return ChangeTierRejected.make({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            rejection: new TierNotInCatalog({ tier: input.tier }),
          });
        }
        const proration = plan.proration;

        if (input.expected === undefined) {
          return ChangeTierQuoted.make({ tier: input.tier, proration });
        }
        if (!sameProration(input.expected, proration)) {
          return ChangeTierRequote.make({ tier: input.tier, proration });
        }

        const commandId =
          input.commandId ?? (yield* Effect.sync(() => globalThis.crypto.randomUUID()));
        const result = yield* Effect.result(
          asSystem(subscription.send(ref, plan.command, { commandId })),
        );

        if (Result.isFailure(result)) {
          const failure = result.failure;
          if (failure._tag === "ProrationMismatch") {
            return ChangeTierRequote.make({ tier: input.tier, proration: failure.expected });
          }
          const rejection = Schema.decodeOption(ChangeTierRejection)(failure);
          return Option.isSome(rejection)
            ? ChangeTierRejected.make({ commandId, rejection: rejection.value })
            : ChangeTierFailed.make({
                commandId,
                reason: "the model returned a rejection this surface cannot display",
              });
        }

        return ChangeTierApplied.make({
          commandId,
          tier: input.tier,
          proration,
          stream: result.success.stream,
          version: result.success.version,
        });
      }),
  } satisfies AdminChangeTierShape;
});

/** The in-process tier-change port, as one Layer. */
export const AdminChangeTierLive = Layer.effect(AdminChangeTier, makeAdminChangeTier);

/**
 * The write side of the console's server surface. It is separate from
 * `AdminReadsRpcs` because `AdminReads` is a read port: this one sends a
 * command, under the same `Admin` guard.
 */
export const AdminChangeTierRpcs = RpcGroup.make(
  Rpc.make("ChangeTier", {
    payload: ChangeTierRequest,
    success: ChangeTierAnswer,
    error: AdminReadError,
  }),
).middleware(Admin);

export const AdminChangeTierHandlers = Effect.map(makeAdminChangeTier, (change) =>
  AdminChangeTierRpcs.of({
    ChangeTier: (input: ChangeTierRequest) => change.change(input),
  }),
);

/** Every RPC the console's server exposes, reads and the tier change. */
export const AdminConsoleRpcs = AdminReadsRpcs.merge(AdminChangeTierRpcs);

const transportFailure = (error: RpcClientError.RpcClientError): AdminReadFailed =>
  new AdminReadFailed({ reason: error.reason._tag, message: error.message });

/**
 * The browser/Worker client for the tier-change RPC. It shares the console's
 * endpoint with `AdminReadsClient`; the merged server group dispatches by tag.
 *
 * @layer
 */
export const AdminChangeTierClient = (
  url: string,
  options: {
    readonly headers?: Headers.Input;
    readonly transformClient?: <E, R>(
      client: HttpClient.HttpClient.With<E, R>,
    ) => HttpClient.HttpClient.With<E, R>;
  } = {},
): Layer.Layer<AdminChangeTier, never, HttpClient.HttpClient> =>
  Layer.effect(
    AdminChangeTier,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(AdminChangeTierRpcs);
      const call = <A>(
        effect: Effect.Effect<A, AdminReadError | RpcClientError.RpcClientError>,
      ): Effect.Effect<A, AdminReadError> =>
        (options.headers === undefined
          ? effect
          : RpcClient.withHeaders(effect, options.headers)
        ).pipe(Effect.catchTag("RpcClientError", (error) => Effect.fail(transportFailure(error))));

      return {
        change: (input) => call(client.ChangeTier(input)),
      } satisfies AdminChangeTierShape;
    }),
  ).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url,
        ...(options.transformClient === undefined
          ? {}
          : { transformClient: options.transformClient }),
      }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
  );
