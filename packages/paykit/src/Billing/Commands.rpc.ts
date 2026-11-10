import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import { Allowance } from "../Allowance.ts";
import { asSystem } from "../Auth/Actor.ts";
import { CrossOrigin } from "../Auth/CrossOrigin.rejection.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CatalogService } from "../CatalogService.ts";
import { BillingControls } from "../Customer.ts";
import { AlreadyCanceled } from "../Subscription/AlreadyCanceled.rejection.ts";
import { BillingState, BillingStateView } from "../Subscription/BillingState.view.ts";
import { CancelGroup as CancelGroupCommand } from "../Subscription/CancelGroup.command.ts";
import { DefaultPlanNotCancelable, PlanGroupEmpty } from "../Subscription/CancelGroup.command.ts";
import { CurrencyMismatch } from "../Subscription/CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { PlanPhaseNamesAddOn } from "../Subscription/PlanPhaseNamesAddOn.rejection.ts";
import { PlanPhaseNotFuture } from "../Subscription/PlanPhaseNotFuture.rejection.ts";
import { PlanVersionStale } from "../Subscription/PlanVersionStale.rejection.ts";
import { ScheduleCancellation as ScheduleCancellationCommand } from "../Subscription/ScheduleCancellation.command.ts";
import { ScheduleTierChange as ScheduleTierChangeCommand } from "../Subscription/ScheduleTierChange.command.ts";
import {
  ControlsDuplicate,
  ControlsFeatureNotPriced,
  ControlsFeatureUnknown,
  SetBillingControls as SetBillingControlsCommand,
} from "../Subscription/SetBillingControls.command.ts";
import { StandingEnded } from "../Subscription/StandingEnded.rejection.ts";
import { StartTrial as StartTrialCommand } from "../Subscription/StartTrial.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import { currencyOf, SubscriptionStatus } from "../Subscription/Subscription.state.ts";
import { TrialAlreadyUsed } from "../Subscription/TrialAlreadyUsed.rejection.ts";
import { TrialDeadlineNotLater } from "../Subscription/TrialDeadlineNotLater.rejection.ts";
import { Price } from "../Tier.ts";
import { scheduleTierChangeInputOf, subscribeInputOf, withGrants } from "../TierCommand.ts";
import { transportMessage } from "./Bindings.ts";
import { defaultPlanFor } from "./Cancel.binding.ts";
import { controlFeaturesOf } from "./SetBillingControls.binding.ts";

/**
 * One server-expanded tenant command. The client names the account and the plan;
 * the deployment joins the catalog's terms and sends the model command itself.
 *
 * The command's payload cannot be enriched between the RPC decode and `decide`
 * — `decide` is pure and `CatalogGuard` only checks what arrived — so the join
 * has to be its own surface beside `BillingApi`. This is that surface: four
 * commands whose payload a client can state without holding the catalog.
 */
export const StartTrialCommandRequest = Schema.Struct({
  /** The account the command targets. The `Session` middleware pins an account actor to it. */
  target: Schema.String,
  tier: Schema.String,
  trialEndsAt: Schema.DateTimeUtc,
  anchorTz: Schema.optionalKey(Schema.String),
  currency: Schema.optionalKey(Schema.String),
  /** The retry key, which is also the command id. */
  dedupeKey: Schema.String,
});

export type StartTrialCommandRequest = typeof StartTrialCommandRequest.Type;

/** The standing the trial opened. */
export const StartTrialCommandResult = Schema.Struct({
  tier: Schema.String,
  status: SubscriptionStatus,
  trialEndsAt: Schema.NullOr(Schema.DateTimeUtc),
});

export type StartTrialCommandResult = typeof StartTrialCommandResult.Type;

/** The plan a scheduled change names, with the bespoke terms a custom plan may carry. */
export const ScheduleTierChangeCommandRequest = Schema.Struct({
  target: Schema.String,
  tier: Schema.String,
  grants: Schema.optionalKey(Schema.Array(Allowance)),
  price: Schema.optionalKey(Price),
  dedupeKey: Schema.String,
});

export type ScheduleTierChangeCommandRequest = typeof ScheduleTierChangeCommandRequest.Type;

/** The tier the standing will move to at the boundary. */
export const ScheduleTierChangeCommandResult = Schema.Struct({
  pendingTier: Schema.NullOr(Schema.String),
});

export type ScheduleTierChangeCommandResult = typeof ScheduleTierChangeCommandResult.Type;

/** A cancellation, whole-account or one group. */
export const ScheduleCancellationCommandRequest = Schema.Struct({
  target: Schema.String,
  group: Schema.optionalKey(Schema.String),
  dedupeKey: Schema.String,
});

export type ScheduleCancellationCommandRequest = typeof ScheduleCancellationCommandRequest.Type;

/** Whether the standing ends at the boundary. */
export const ScheduleCancellationCommandResult = Schema.Struct({
  cancelAtPeriodEnd: Schema.Boolean,
  group: Schema.optionalKey(Schema.String),
});

export type ScheduleCancellationCommandResult = typeof ScheduleCancellationCommandResult.Type;

/** The customer's controls, with no catalog facts on the wire. */
export const SetBillingControlsCommandRequest = Schema.Struct({
  target: Schema.String,
  billingControls: Schema.optionalKey(BillingControls),
});

export type SetBillingControlsCommandRequest = typeof SetBillingControlsCommandRequest.Type;

/** What the write left in force, and the view it waited for. */
export const SetBillingControlsCommandResult = Schema.Struct({
  billingControls: Schema.optionalKey(BillingControls),
  view: Schema.NullOr(BillingStateView),
});

export type SetBillingControlsCommandResult = typeof SetBillingControlsCommandResult.Type;

/**
 * The command never reached the deployment: the transport failed or the reply
 * did not decode. It is a fact about this surface, not a model refusal, so the
 * binding maps it to `BindingFailed` and a caller retries with the same key.
 */
export class BillingCommandUnavailable extends Schema.TaggedError<BillingCommandUnavailable>()(
  "BillingCommandUnavailable",
  { message: Schema.String },
) {}

/** How a remote command authenticates the call. */
export interface BillingCommandCall {
  readonly headers?: Headers.Input;
}

const StartTrialCommandErrorSchema = Schema.Union([
  TrialAlreadyUsed,
  TrialDeadlineNotLater,
  PlanNotInCatalog,
  CatalogMismatch,
  CurrencyMismatch,
  Unauthenticated,
  Forbidden,
  CrossOrigin,
  BillingCommandUnavailable,
  Domain.ConsistencyTimeout,
]);

/** Every failure a server-expanded trial can answer. */
export type StartTrialCommandError = typeof StartTrialCommandErrorSchema.Type;

const ScheduleTierChangeCommandErrorSchema = Schema.Union([
  NotSubscribed,
  StandingEnded,
  PlanNotInCatalog,
  PlanPhaseNotFuture,
  PlanPhaseNamesAddOn,
  CurrencyMismatch,
  CatalogMismatch,
  PlanVersionStale,
  Unauthenticated,
  Forbidden,
  CrossOrigin,
  BillingCommandUnavailable,
  Domain.ConsistencyTimeout,
]);

/** Every failure a server-expanded schedule can answer. */
export type ScheduleTierChangeCommandError = typeof ScheduleTierChangeCommandErrorSchema.Type;

const ScheduleCancellationCommandErrorSchema = Schema.Union([
  NotSubscribed,
  StandingEnded,
  AlreadyCanceled,
  DefaultPlanNotCancelable,
  PlanGroupEmpty,
  Unauthenticated,
  Forbidden,
  CrossOrigin,
  BillingCommandUnavailable,
  Domain.ConsistencyTimeout,
]);

/** Every failure a server-expanded cancellation can answer. */
export type ScheduleCancellationCommandError = typeof ScheduleCancellationCommandErrorSchema.Type;

const SetBillingControlsCommandErrorSchema = Schema.Union([
  ControlsFeatureUnknown,
  ControlsFeatureNotPriced,
  ControlsDuplicate,
  CatalogMismatch,
  Unauthenticated,
  Forbidden,
  CrossOrigin,
  BillingCommandUnavailable,
  Domain.ConsistencyTimeout,
]);

/** Every failure a server-expanded controls write can answer. */
export type SetBillingControlsCommandError = typeof SetBillingControlsCommandErrorSchema.Type;

/** The four tenant commands whose catalog join belongs to the deployment. */
export interface BillingCommandsShape {
  readonly startTrial: (
    input: StartTrialCommandRequest,
    call?: BillingCommandCall,
  ) => Effect.Effect<StartTrialCommandResult, StartTrialCommandError>;
  readonly scheduleTierChange: (
    input: ScheduleTierChangeCommandRequest,
    call?: BillingCommandCall,
  ) => Effect.Effect<ScheduleTierChangeCommandResult, ScheduleTierChangeCommandError>;
  readonly scheduleCancellation: (
    input: ScheduleCancellationCommandRequest,
    call?: BillingCommandCall,
  ) => Effect.Effect<ScheduleCancellationCommandResult, ScheduleCancellationCommandError>;
  readonly setBillingControls: (
    input: SetBillingControlsCommandRequest,
    call?: BillingCommandCall,
  ) => Effect.Effect<SetBillingControlsCommandResult, SetBillingControlsCommandError>;
}

/**
 * The deployment's catalog join, as a service. `BillingApiLayer` resolves this
 * service instead of `CatalogService`, so a client that only speaks the Api
 * needs no catalog copy.
 *
 * @primitive
 */
export class BillingCommands extends Context.Service<BillingCommands, BillingCommandsShape>()(
  "paykit/BillingCommands",
) {}

/** The tier a standing will move to at its boundary, or `null` when nothing is scheduled. */
const viewTier = (
  view: { readonly pendingTier?: { readonly tier: string } } | null,
): string | null => view?.pendingTier?.tier ?? null;

/** The server-side join, built from the catalog and the standing. */
export const makeBillingCommands = Effect.gen(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;
  const billing = yield* BillingState;

  return {
    startTrial: Effect.fn("Paykit.BillingCommands.startTrial")(function* (
      input: StartTrialCommandRequest,
    ) {
      const ref = Subscription.ref(input.target);

      const grant = subscribeInputOf(catalog, input.tier, {
        ...(input.anchorTz === undefined ? {} : { anchorTz: input.anchorTz }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
      });

      if (grant === null) {
        return yield* new PlanNotInCatalog({ tier: input.tier });
      }

      const receipt = yield* asSystem(
        subscription.send(
          ref,
          new StartTrialCommand({ ...grant, trialEndsAt: input.trialEndsAt }),
          { commandId: input.dedupeKey },
        ),
      );

      const view = yield* billing.query(ref, { atLeast: receipt });
      const standing = Option.getOrNull(view);

      return {
        tier: standing?.tier ?? input.tier,
        status: standing?.status ?? "trialing",
        trialEndsAt: standing?.trialEndsAt ?? null,
      } satisfies StartTrialCommandResult;
    }),
    scheduleTierChange: Effect.fn("Paykit.BillingCommands.scheduleTierChange")(function* (
      input: ScheduleTierChangeCommandRequest,
    ) {
      const ref = Subscription.ref(input.target);
      const state = yield* subscription.state(ref);

      const scheduled = scheduleTierChangeInputOf(
        catalog,
        input.tier,
        input.price === undefined && state._tag === "Subscribed" ? currencyOf(state) : undefined,
      );

      if (scheduled === null) {
        return yield* new PlanNotInCatalog({ tier: input.tier });
      }

      const granted = withGrants(catalog, scheduled, input.grants, input.price);
      const mismatch = granted.mismatch;

      if (mismatch !== null) return yield* mismatch;

      const receipt = yield* asSystem(
        subscription.send(ref, new ScheduleTierChangeCommand(granted.input), {
          commandId: input.dedupeKey,
        }),
      );

      const view = yield* billing.query(ref, { atLeast: receipt });

      return {
        pendingTier: viewTier(Option.getOrNull(view)),
      } satisfies ScheduleTierChangeCommandResult;
    }),
    scheduleCancellation: Effect.fn("Paykit.BillingCommands.scheduleCancellation")(function* (
      input: ScheduleCancellationCommandRequest,
    ) {
      const ref = Subscription.ref(input.target);
      const state = yield* subscription.state(ref);

      const fallback =
        input.group === undefined
          ? undefined
          : defaultPlanFor(
              catalog,
              input.group,
              state._tag === "Subscribed" ? currencyOf(state) : undefined,
            );

      const receipt =
        input.group === undefined
          ? yield* asSystem(
              subscription.send(ref, new ScheduleCancellationCommand(), {
                commandId: input.dedupeKey,
              }),
            )
          : yield* asSystem(
              subscription.send(
                ref,
                new CancelGroupCommand({
                  group: input.group,
                  ...(fallback === undefined ? {} : { fallback }),
                }),
                { commandId: input.dedupeKey },
              ),
            );

      const view = yield* billing.query(ref, { atLeast: receipt });

      return {
        cancelAtPeriodEnd: Option.getOrNull(view)?.cancelAtPeriodEnd ?? false,
        ...(input.group === undefined ? {} : { group: input.group }),
      } satisfies ScheduleCancellationCommandResult;
    }),
    setBillingControls: Effect.fn("Paykit.BillingCommands.setBillingControls")(function* (
      input: SetBillingControlsCommandRequest,
    ) {
      const ref = Subscription.ref(input.target);

      const receipt = yield* asSystem(
        subscription.send(
          ref,
          new SetBillingControlsCommand({
            ...(input.billingControls === undefined
              ? {}
              : { billingControls: input.billingControls }),
            features: controlFeaturesOf(catalog, input.billingControls),
          }),
        ),
      );

      const view = yield* billing.query(ref, { atLeast: receipt });
      const standing = Option.getOrNull(view);
      const billingControls = standing?.billingControls;

      return {
        ...(billingControls === undefined ? {} : { billingControls }),
        view: standing,
      } satisfies SetBillingControlsCommandResult;
    }),
  } satisfies BillingCommandsShape;
});

/**
 * The server-side implementation: the catalog and the standing are read here,
 * the command is built here, and the model is sent exactly once.
 *
 * It is the same join `BillingInProcess` makes. The Api layer uses it through
 * the wire, and a test or a Worker can provide it directly when the model and
 * the client share a process.
 *
 * @layer
 */
export const BillingCommandsLive = Layer.effect(BillingCommands, makeBillingCommands);

/**
 * The server-expanded tenant commands as Effect RPC, behind the tenant
 * `Session` guard. The payload carries the account as `target`, so the guard
 * pins an account actor to itself exactly as it does for a `BillingApi` command.
 */
export const BillingCommandsRpcs = RpcGroup.make(
  Rpc.make("StartTrial", {
    payload: StartTrialCommandRequest,
    success: StartTrialCommandResult,
    error: StartTrialCommandErrorSchema,
  }),
  Rpc.make("ScheduleTierChange", {
    payload: ScheduleTierChangeCommandRequest,
    success: ScheduleTierChangeCommandResult,
    error: ScheduleTierChangeCommandErrorSchema,
  }),
  Rpc.make("ScheduleCancellation", {
    payload: ScheduleCancellationCommandRequest,
    success: ScheduleCancellationCommandResult,
    error: ScheduleCancellationCommandErrorSchema,
  }),
  Rpc.make("SetBillingControls", {
    payload: SetBillingControlsCommandRequest,
    success: SetBillingControlsCommandResult,
    error: SetBillingControlsCommandErrorSchema,
  }),
).middleware(Session);

/** The handlers a Worker serves, built from the deployment's own catalog join. */
export const BillingCommandsHandlers = Effect.map(BillingCommands, (commands) =>
  BillingCommandsRpcs.of({
    StartTrial: (input: StartTrialCommandRequest) => commands.startTrial(input),
    ScheduleTierChange: (input: ScheduleTierChangeCommandRequest) =>
      commands.scheduleTierChange(input),
    ScheduleCancellation: (input: ScheduleCancellationCommandRequest) =>
      commands.scheduleCancellation(input),
    SetBillingControls: (input: SetBillingControlsCommandRequest) =>
      commands.setBillingControls(input),
  }),
);

/**
 * Serve the server-expanded commands beside the tenant Api. The `Session`
 * context is captured once, following `Domain.Api`'s serve path, so a custom
 * guard layer cannot be dropped by forgetting to merge one more layer.
 *
 * ### One Worker, two tenant surfaces
 * **Example:** The Api and the catalog join
 * ```typescript
 * const api = yield* BillingApi;
 * const commands = yield* Paykit.BillingCommandsServer;
 *
 * fetch: Effect.gen(function* () {
 *   const path = new URL((yield* HttpServerRequest).url, "http://billing").pathname;
 *   if (path.startsWith("/api/commands")) return yield* commands;
 *   return yield* api.fetch;
 * })
 * ```
 */
export const BillingCommandsServer = Effect.gen(function* () {
  const handlers = yield* BillingCommandsHandlers;
  const middleware = yield* Effect.context<Session>();

  return yield* Effect.succeed(
    RpcServer.toHttpEffect(BillingCommandsRpcs).pipe(
      Effect.flatten,
      Effect.provide(
        Layer.mergeAll(
          BillingCommandsRpcs.toLayer(handlers),
          RpcSerialization.layerNdjson,
          Layer.succeedContext(middleware),
        ),
      ),
    ),
  );
});

/** What a remote command client needs to reach the deployment. */
export interface BillingCommandsClientOptions {
  /** Send the caller's own credentials when the Api is not behind a same-origin cookie. */
  readonly headers?: Headers.Input;
  /** Rewrite every request the client sends, as `PaykitCatalogClient` does. */
  readonly transformClient?: <E, R>(
    client: HttpClient.HttpClient.With<E, R>,
  ) => HttpClient.HttpClient.With<E, R>;
}

/**
 * The browser/Worker client for `BillingCommandsRpcs`. Provide an `HttpClient`
 * (for a browser, `FetchHttpClient.layer`); a same-origin session cookie
 * authenticates every call.
 *
 * Point it at the commands route, which `Paykit.handler` mounts at
 * `${tenant}/commands` by default.
 *
 * @layer
 */
export const BillingCommandsClient = (
  url: string,
  options: BillingCommandsClientOptions = {},
): Layer.Layer<BillingCommands, never, HttpClient.HttpClient> =>
  Layer.effect(
    BillingCommands,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(BillingCommandsRpcs);

      const call = <A, E, R>(
        effect: Effect.Effect<A, E | RpcClientError.RpcClientError, R>,
        call?: BillingCommandCall,
      ): Effect.Effect<A, E | BillingCommandUnavailable, R> => {
        const headers = call?.headers ?? options.headers;
        const sent = headers === undefined ? effect : RpcClient.withHeaders(effect, headers);

        return sent.pipe(
          Effect.catchTag("RpcClientError", (error) =>
            Effect.fail(new BillingCommandUnavailable({ message: transportMessage(error) })),
          ),
        );
      };

      return {
        startTrial: (input, callOptions) => call(client.StartTrial(input), callOptions),
        scheduleTierChange: (input, callOptions) =>
          call(client.ScheduleTierChange(input), callOptions),
        scheduleCancellation: (input, callOptions) =>
          call(client.ScheduleCancellation(input), callOptions),
        setBillingControls: (input, callOptions) =>
          call(client.SetBillingControls(input), callOptions),
      } satisfies BillingCommandsShape;
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
