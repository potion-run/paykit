import type * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as Reactivity from "effect/reactivity/Reactivity";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type { Forbidden } from "./Auth/Forbidden.rejection.ts";
import type { Unauthenticated } from "./Auth/Unauthenticated.rejection.ts";
import { BillingApiLayer } from "./Billing/BillingApi.layer.ts";
import { BindingCall, callOptionsOf } from "./Billing/Bindings.ts";
import {
  Resume,
  ScheduleCancellation,
  type CancelError,
  type CancelRequest,
  type ResumeError,
  type StandingResult,
} from "./Billing/Cancel.binding.ts";
import { Check, type CheckError, type CheckRequest } from "./Billing/Check.binding.ts";
import {
  ConsumeCredits,
  type ConsumeCreditsError,
  type ConsumeCreditsRequest,
  type ConsumeCreditsResult,
} from "./Billing/ConsumeCredits.binding.ts";
import { Hold, type HoldError, type HoldRequest, type HoldResult } from "./Billing/Hold.binding.ts";
import {
  ReleaseHold,
  type ReleaseHoldError,
  type ReleaseHoldRequest,
  type ReleaseHoldResult,
} from "./Billing/ReleaseHold.binding.ts";
import {
  ScheduleTierChange,
  WithdrawTierChange,
  type PendingTierResult,
  type ScheduleTierChangeError,
  type ScheduleTierChangeRequest,
  type WithdrawTierChangeError,
  type WithdrawTierChangeRequest,
} from "./Billing/ScheduleTierChange.binding.ts";
import {
  SettleHold,
  type SettleHoldError,
  type SettleHoldRequest,
  type SettleHoldResult,
} from "./Billing/SettleHold.binding.ts";
import {
  StartTrial,
  type StartTrialError,
  type StartTrialRequest,
  type StartTrialResult,
} from "./Billing/StartTrial.binding.ts";
import {
  TrackUsage,
  type TrackUsageError,
  type TrackUsageRequest,
  type TrackUsageResult,
} from "./Billing/TrackUsage.binding.ts";
import { BillingApi } from "./BillingApi.api.ts";
import { type CatalogService } from "./CatalogService.ts";
import type { CheckResult } from "./Check.ts";
import { type BillingStateView } from "./Subscription/BillingState.view.ts";
import { type EntitlementsState } from "./Subscription/Entitlements.view.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";

/**
 * Everything a client verb can say besides the model's own refusal: the caller
 * is not signed in, the account is not theirs, the read landed after its
 * deadline, or the transport lost the reply.
 *
 * The distinction is the binding's, not the atom client's: a refusal means the
 * write did not happen, while a transport failure means we do not know.
 */
export type BillingAtomRemoteError =
  | Unauthenticated
  | Forbidden
  | Domain.ConsistencyTimeout
  | RpcClientError.RpcClientError;

/** The result of one view read, as an atom exposes it. */
export type BillingQuery<A, E = never> = Atom.Atom<
  AsyncResult.AsyncResult<A | null, BillingAtomRemoteError | E>
>;

/** A command as an atom: write a request, read the `AsyncResult`. */
export type BillingMutation<Request, Result, Error, E = never> = Atom.AtomResultFn<
  Request,
  Result,
  Error | E
>;

/** The command atoms `make` exposes, named after the bindings they wrap. */
export type BillingAtomVerb =
  | "trackUsage"
  | "hold"
  | "settleHold"
  | "releaseHold"
  | "consumeCredits"
  | "scheduleCancellation"
  | "resume"
  | "scheduleTierChange"
  | "withdrawTierChange"
  | "startTrial";

/** The service key of the paykit Api client the layer provides. */
export type BillingClient = Domain.Api.ClientKey<"BillingApi">;

/** The services a built atom runtime carries: the Api client, the catalog, and every tenant verb. */
export type BillingAtomServices =
  | BillingClient
  | CatalogService
  | Check
  | TrackUsage
  | Hold
  | SettleHold
  | ReleaseHold
  | ConsumeCredits
  | ScheduleCancellation
  | Resume
  | ScheduleTierChange
  | WithdrawTierChange
  | StartTrial;

/** What `make` needs: one layer that reaches the Api and the catalog. */
export interface BillingAtomOptions<E = never> {
  /**
   * The transport and the catalog, built once. A browser client is
   * `BillingApi.layerClientHttp(url)` with `FetchHttpClient.layer` and the
   * deploy's `catalogLayer(Catalog)`; a test is
   * `BillingApi.layerClientInProcess` with the same catalog.
   */
  readonly layer: Layer.Layer<BillingClient | CatalogService, E, never>;
  /**
   * The atom runtime factory to build on. Defaults to `Atom.runtime`; supply
   * the application's own factory to share its layers and invalidation.
   */
  readonly runtime?: Atom.RuntimeFactory;
  /**
   * Extra reactivity keys a successful command invalidates, by verb. An
   * application query wrapped in `billing.runtime.factory.withReactivity`
   * with one of these keys refreshes with the paykit views.
   */
  readonly reactivityKeys?: Partial<Record<BillingAtomVerb, Reactivity.KeysInput>>;
}

/** The atoms one paykit client exposes. */
export interface BillingAtoms<E = never> {
  /** The runtime an application composes its own queries on. */
  readonly runtime: Atom.AtomRuntime<BillingAtomServices, E>;
  /** One account's entitlement view: remaining, standing, credits, resets. */
  readonly entitlements: (account: string) => BillingQuery<EntitlementsState, E>;
  /** One account's billing page: tier, price, period, pending change, grace. */
  readonly billing: (account: string) => BillingQuery<BillingStateView, E>;
  /**
   * Ask whether an amount is allowed. A command atom because the amount is
   * part of the question: write the request, read the answer. The `entitlements`
   * view already carries `allowed` per feature when no amount is involved.
   */
  readonly check: (account: string) => BillingMutation<CheckRequest, CheckResult, CheckError, E>;
  /** Record usage, then refresh this account's views. */
  readonly trackUsage: (
    account: string,
  ) => BillingMutation<TrackUsageRequest, TrackUsageResult, TrackUsageError, E>;
  /** Reserve units for work that has started. */
  readonly hold: (account: string) => BillingMutation<HoldRequest, HoldResult, HoldError, E>;
  /** Bill what ran and return the rest of a hold. */
  readonly settleHold: (
    account: string,
  ) => BillingMutation<SettleHoldRequest, SettleHoldResult, SettleHoldError, E>;
  /** Return a hold without billing it. */
  readonly releaseHold: (
    account: string,
  ) => BillingMutation<ReleaseHoldRequest, ReleaseHoldResult, ReleaseHoldError, E>;
  /** Spend the credit pool. */
  readonly consumeCredits: (
    account: string,
  ) => BillingMutation<ConsumeCreditsRequest, ConsumeCreditsResult, ConsumeCreditsError, E>;
  /** End the standing at the period boundary. */
  readonly scheduleCancellation: (
    account: string,
  ) => BillingMutation<CancelRequest, StandingResult, CancelError, E>;
  /** Undo a scheduled cancellation. */
  readonly resume: (
    account: string,
  ) => BillingMutation<CancelRequest, StandingResult, ResumeError, E>;
  /** Move to another tier at the next boundary. */
  readonly scheduleTierChange: (
    account: string,
  ) => BillingMutation<ScheduleTierChangeRequest, PendingTierResult, ScheduleTierChangeError, E>;
  /** Withdraw a scheduled tier change. */
  readonly withdrawTierChange: (
    account: string,
  ) => BillingMutation<WithdrawTierChangeRequest, PendingTierResult, WithdrawTierChangeError, E>;
  /** Start a trial until a deadline the caller states. */
  readonly startTrial: (
    account: string,
  ) => BillingMutation<StartTrialRequest, StartTrialResult, StartTrialError, E>;
}

/** The key every query for one account registers, so one mutation refreshes them all. */
export const accountReactivityKey = (account: string): string => `paykit/account/${account}`;

const keysFor = (
  account: string,
  extra: Reactivity.KeysInput | undefined,
): Reactivity.KeysInput => {
  if (Array.isArray(extra)) return ["paykit", accountReactivityKey(account), ...extra];
  const merged: Record<string, ReadonlyArray<unknown>> = {
    paykit: [],
    [accountReactivityKey(account)]: [],
  };
  if (extra !== undefined) Object.assign(merged, extra);
  return merged;
};

/**
 * The headers a binding call carries, if the deployment supplied them. A
 * same-origin browser client omits them and the session cookie does the work;
 * a remote client provides `BindingCall` beside the Api protocol.
 */
const callOptions = Effect.gen(function* () {
  const call = yield* Effect.serviceOption(BindingCall);
  return Option.isNone(call) ? {} : callOptionsOf(call)();
});

/** The Api speaks branded ids; the atom client takes the id as it arrives and brands it once. */
const accountId = (account: string) => Subscription.ref(account).id;

const entitlementsAtom = <E>(
  runtime: Atom.AtomRuntime<BillingAtomServices, E>,
  account: string,
): Atom.Atom<AsyncResult.AsyncResult<EntitlementsState | null, BillingAtomRemoteError | E>> =>
  runtime.atom(
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = yield* callOptions;
      return yield* client.Entitlements.get(accountId(account), options);
    }),
  ) as Atom.Atom<AsyncResult.AsyncResult<EntitlementsState | null, BillingAtomRemoteError | E>>;

const billingAtom = <E>(
  runtime: Atom.AtomRuntime<BillingAtomServices, E>,
  account: string,
): Atom.Atom<AsyncResult.AsyncResult<BillingStateView | null, BillingAtomRemoteError | E>> =>
  runtime.atom(
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = yield* callOptions;
      return yield* client.BillingState.get(accountId(account), options);
    }),
  ) as Atom.Atom<AsyncResult.AsyncResult<BillingStateView | null, BillingAtomRemoteError | E>>;

/**
 * Billing as Effect atoms: the tenant bindings, shaped for a client.
 *
 * `make` builds one runtime over the layer that reaches your Api — an HTTP
 * client in a browser, the in-process client in a test — and returns the
 * queries and commands a component reads. A successful command invalidates the
 * account's reactivity key, so `entitlements` and `billing` refresh after every
 * write without the caller wiring a subscription. `check` is a command atom
 * because the amount is part of the question.
 *
 * The runtime is a normal `Atom.AtomRuntime`: compose an application query on
 * the same client with `billing.runtime.atom(...)`, and wrap it in
 * `billing.runtime.factory.withReactivity([PaykitAtom.accountReactivityKey(account)])`
 * to refresh it with the paykit writes.
 *
 * ### Reading an entitlement and tracking usage
 * **Example:** A React page over a served paykit Api
 * ```typescript
 * import { RegistryProvider, useAtomSet, useAtomValue } from "@effect/atom-react";
 * import { BillingApi, catalogLayer } from "@potion.run/paykit";
 * import * as PaykitAtom from "@potion.run/paykit/Atom";
 * import { Layer } from "effect";
 * import * as FetchHttpClient from "effect/http/FetchHttpClient";
 * import * as AsyncResult from "effect/reactivity/AsyncResult";
 * import { Catalog } from "./catalog.ts";
 *
 * export const billing = PaykitAtom.make({
 *   layer: Layer.mergeAll(
 *     catalogLayer(Catalog),
 *     BillingApi.layerClientHttp("/api/billing").pipe(Layer.provide(FetchHttpClient.layer)),
 *   ),
 * });
 *
 * const entitlements = billing.entitlements("acct_1");
 * const trackUsage = billing.trackUsage("acct_1");
 *
 * function Usage() {
 *   const result = useAtomValue(entitlements);
 *   const view = AsyncResult.isSuccess(result) ? result.value : null;
 *   const track = useAtomSet(trackUsage, { mode: "promise" });
 *   return (
 *     <button onClick={() => track({ feature: "messages", amount: 1, dedupeKey: crypto.randomUUID() })}>
 *       {view?.features.messages?.remaining ?? "…"} left
 *     </button>
 *   );
 * }
 *
 * export const App = () => (
 *   <RegistryProvider>
 *     <Usage />
 *   </RegistryProvider>
 * );
 * ```
 *
 * @primitive
 * @product Usage
 */
export const make = <E = never>(options: BillingAtomOptions<E>): BillingAtoms<E> => {
  const factory = options.runtime ?? Atom.runtime;
  const runtime = factory(
    // `provideMerge` keeps the Api client and the catalog on the runtime, so an
    // application query — and a test that seeds a standing — can reach them
    // without rebuilding the transport.
    BillingApiLayer.pipe(Layer.provideMerge(options.layer)),
  ) as Atom.AtomRuntime<BillingAtomServices, E>;

  const withAccount = (account: string) =>
    factory.withReactivity(["paykit", accountReactivityKey(account)]);

  // One atom per account: a component may call `billing.entitlements(id)` on
  // every render without handing `useAtomValue` a new atom each time.
  //
  // The Api client decodes a rejection into the schema `Instance<...>` form;
  // the public alias names the same class a caller matches, so the cast keeps
  // the atom's error channel readable at the call site.
  const entitlements = Atom.family((account: string): BillingQuery<EntitlementsState, E> =>
    Atom.withServerValueInitial(
      entitlementsAtom(runtime, account) as BillingQuery<EntitlementsState, E>,
    ).pipe(withAccount(account)),
  );

  const billing = Atom.family((account: string): BillingQuery<BillingStateView, E> =>
    Atom.withServerValueInitial(
      billingAtom(runtime, account) as BillingQuery<BillingStateView, E>,
    ).pipe(withAccount(account)),
  );

  /**
   * One command over a bound verb. The binding joins the catalog and waits for
   * the view; the atom only adds the request and the invalidation.
   */
  const command =
    <Request, Result, Error>(
      verb: BillingAtomVerb,
      service: (
        account: string,
      ) => Effect.Effect<
        (request: Request) => Effect.Effect<Result, Error>,
        never,
        BillingAtomServices
      >,
    ) =>
    (account: string): BillingMutation<Request, Result, Error, E> =>
      runtime.fn(
        (request: Request) =>
          Effect.gen(function* () {
            const bound = yield* service(account);
            return yield* bound(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.[verb]) },
      );

  // `check` answers a question; it writes nothing, so it invalidates nothing.
  // It is still a command atom because the amount is part of the request.
  const check = Atom.family(
    (account: string): BillingMutation<CheckRequest, CheckResult, CheckError, E> =>
      runtime.fn((request: CheckRequest) =>
        Effect.gen(function* () {
          const bound = yield* Check(account);
          return yield* bound(request);
        }),
      ),
  );

  // Every command is per account too, so its reactivity key is the account's
  // and a component may call `billing.trackUsage(id)` while rendering.
  const motion = <Request, Result, Error>(
    verb: BillingAtomVerb,
    service: (
      account: string,
    ) => Effect.Effect<
      (request: Request) => Effect.Effect<Result, Error>,
      never,
      BillingAtomServices
    >,
  ) => Atom.family((account: string) => command(verb, service)(account));

  return {
    runtime,
    entitlements,
    billing,
    check,
    trackUsage: motion("trackUsage", TrackUsage),
    hold: motion("hold", Hold),
    settleHold: motion("settleHold", SettleHold),
    releaseHold: motion("releaseHold", ReleaseHold),
    consumeCredits: motion("consumeCredits", ConsumeCredits),
    scheduleCancellation: motion("scheduleCancellation", ScheduleCancellation),
    resume: motion("resume", Resume),
    scheduleTierChange: motion("scheduleTierChange", ScheduleTierChange),
    withdrawTierChange: motion("withdrawTierChange", WithdrawTierChange),
    startTrial: motion("startTrial", StartTrial),
  };
};
