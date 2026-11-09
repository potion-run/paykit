import type * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as Reactivity from "effect/reactivity/Reactivity";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type { Forbidden } from "./Auth/Forbidden.rejection.ts";
import type { Unauthenticated } from "./Auth/Unauthenticated.rejection.ts";
import { balancesOf, type Balance } from "./Balance.ts";
import {
  Balances,
  type BalanceCreateRequest,
  type BalanceFinalizeRequest,
  type BalanceUpdateRequest,
  type BalancesError,
} from "./Billing/Balances.binding.ts";
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
import { BillingCommands, BillingCommandsClient } from "./Billing/Commands.rpc.ts";
import {
  ConsumeCredits,
  type ConsumeCreditsError,
  type ConsumeCreditsRequest,
  type ConsumeCreditsResult,
} from "./Billing/ConsumeCredits.binding.ts";
import type { CreateCustomer, CustomerRequest } from "./Billing/CreateCustomer.binding.ts";
import {
  Customers,
  type CustomerUpdateRequest,
  type CustomersError,
} from "./Billing/Customers.binding.ts";
import {
  Entities,
  type EntitiesError,
  type EntityArchiveRequest,
  type EntityCreateRequest,
  type EntityUpdateRequest,
} from "./Billing/Entities.binding.ts";
import { GrantBalance } from "./Billing/GrantBalance.binding.ts";
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
import type { SetBillingControls } from "./Billing/SetBillingControls.binding.ts";
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
import {
  TransferBalance,
  type TransferBalanceError,
  type TransferBalanceRequest,
  type TransferBalanceResult,
} from "./Billing/TransferBalance.binding.ts";
import { BillingApi } from "./BillingApi.api.ts";
import type { CheckResult } from "./Check.ts";
import type { Customer, Entity } from "./Customer.ts";
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
  | "createBalance"
  | "updateBalance"
  | "finalizeBalance"
  | "trackUsage"
  | "hold"
  | "settleHold"
  | "releaseHold"
  | "consumeCredits"
  | "scheduleCancellation"
  | "resume"
  | "scheduleTierChange"
  | "withdrawTierChange"
  | "updateBillingControls"
  | "createCustomer"
  | "getOrCreateCustomer"
  | "startTrial"
  | "createEntity"
  | "updateEntity"
  | "archiveEntity"
  | "transferBalance";

/** The service key of the paykit Api client the layer provides. */
export type BillingClient = Domain.Api.ClientKey<"BillingApi">;

/** The services a built atom runtime carries: the Api client, the server join, and every tenant verb. */
export type BillingAtomServices =
  | BillingClient
  | BillingCommands
  | Balances
  | GrantBalance
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
  | Customers
  | CreateCustomer
  | Entities
  | TransferBalance
  | SetBillingControls
  | StartTrial;

/** What every `make` form shares: the runtime and the invalidation keys. */
export interface BillingAtomBaseOptions {
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

/**
 * `make` over a layer you built: the transport and the server join, built once.
 * A test uses `BillingApi.layerClientInProcess` and `BillingCommandsLive`; a
 * deployment with a custom transport uses this form.
 */
export interface BillingAtomLayerOptions<E = never> extends BillingAtomBaseOptions {
  readonly layer: Layer.Layer<BillingClient | BillingCommands, E, never>;
}

/**
 * `make` over an HTTP Api: the common browser case. `make` builds the Api and
 * server-command clients, and provides `FetchHttpClient` unless one is given.
 */
export interface BillingAtomUrlOptions extends BillingAtomBaseOptions {
  /** The base URL of the served `BillingApi`, e.g. `/api/billing`. */
  readonly url: string;
  /**
   * Where the deploy serves its server-expanded commands. Defaults to
   * `${url}/commands`, which is where `Paykit.handler` mounts them.
   */
  readonly commandsUrl?: string;
  /** The HTTP client to use. Defaults to `FetchHttpClient.layer`. */
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
}

/** What `make` needs: a layer, or an HTTP Api and the URL of its server-expanded commands. */
export type BillingAtomOptions<E = never> = BillingAtomLayerOptions<E> | BillingAtomUrlOptions;

/** The atoms one paykit client exposes. */
export interface BillingAtoms<E = never> {
  /** The runtime an application composes its own queries on. */
  readonly runtime: Atom.AtomRuntime<BillingAtomServices, E>;
  /** One account's entitlement view: remaining, standing, credits, resets. */
  readonly entitlements: (account: string) => BillingQuery<EntitlementsState, E>;
  /** One account's billing page: tier, price, period, pending change, grace. */
  readonly billing: (account: string) => BillingQuery<BillingStateView, E>;
  /** Every feature the account holds a balance for, with its sources. */
  readonly balances: (account: string) => BillingQuery<ReadonlyArray<Balance>, E>;
  /** The customer's plans and the controls it states over them. */
  readonly customer: (account: string) => BillingQuery<Customer, E>;
  /** Every child scope this customer attached, archived ones included. */
  readonly entities: (account: string) => BillingQuery<ReadonlyArray<Entity>, E>;
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
  /** Create a standalone grant, and answer the feature's balance. */
  readonly createBalance: (
    account: string,
  ) => BillingMutation<BalanceCreateRequest, Balance, BalancesError, E>;
  /** Replace the customer's controls and answer the customer they left. */
  readonly updateBillingControls: (
    account: string,
  ) => BillingMutation<CustomerUpdateRequest, Customer, CustomersError, E>;
  /** Record the customer's identity, and answer the customer it left. */
  readonly createCustomer: (
    account: string,
  ) => BillingMutation<CustomerRequest, Customer, CustomersError, E>;
  /** The customer as it stands, created with these details when it has none. */
  readonly getOrCreateCustomer: (
    account: string,
  ) => BillingMutation<CustomerRequest, Customer, CustomersError, E>;
  /** Set seat occupancy, and answer the feature's balance. */
  readonly updateBalance: (
    account: string,
  ) => BillingMutation<BalanceUpdateRequest, Balance, BalancesError, E>;
  /** Commit or release a lock `check` placed. */
  readonly finalizeBalance: (
    account: string,
  ) => BillingMutation<BalanceFinalizeRequest, Balance, BalancesError, E>;
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
  /** Create a child scope, idempotent by its entity id. */
  readonly createEntity: (
    account: string,
  ) => BillingMutation<EntityCreateRequest, Entity, EntitiesError, E>;
  /** Rename a child scope; an equal name records nothing. */
  readonly updateEntity: (
    account: string,
  ) => BillingMutation<EntityUpdateRequest, Entity, EntitiesError, E>;
  /** Archive a child scope and return its unspent own sources to the customer. */
  readonly archiveEntity: (
    account: string,
  ) => BillingMutation<EntityArchiveRequest, Entity, EntitiesError, E>;
  /** Move units between two scopes of one customer. */
  readonly transferBalance: (
    account: string,
  ) => BillingMutation<TransferBalanceRequest, TransferBalanceResult, TransferBalanceError, E>;
}

/** The key every query for one account registers, so one mutation refreshes them all. */
export const accountReactivityKey = (account: string): string => `paykit/account/${account}`;

const keysFor = (
  account: string,
  extra: Reactivity.KeysInput | undefined,
): Reactivity.KeysInput => {
  if (Array.isArray(extra)) return ["paykit", accountReactivityKey(account), ...extra];

  return Object.assign({ paykit: [], [accountReactivityKey(account)]: [] }, extra);
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
): Atom.Atom<AsyncResult.AsyncResult<EntitlementsState | null, BillingAtomRemoteError | E>> => {
  const atom = runtime.atom(
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = yield* callOptions;

      return yield* client.Entitlements.get(accountId(account), options);
    }),
  );

  // SAFETY: `runtime.atom` is typed for the layer's channel; the query's own
  // error union is the one this module names, and the runtime carries both.
  return atom as Atom.Atom<
    AsyncResult.AsyncResult<EntitlementsState | null, BillingAtomRemoteError | E>
  >;
};

const billingAtom = <E>(
  runtime: Atom.AtomRuntime<BillingAtomServices, E>,
  account: string,
): Atom.Atom<AsyncResult.AsyncResult<BillingStateView | null, BillingAtomRemoteError | E>> => {
  const atom = runtime.atom(
    Effect.gen(function* () {
      const client = yield* BillingApi.Client;
      const options = yield* callOptions;

      return yield* client.BillingState.get(accountId(account), options);
    }),
  );

  // SAFETY: the same runtime atom as `entitlementsAtom`, for the same reason.
  return atom as Atom.Atom<
    AsyncResult.AsyncResult<BillingStateView | null, BillingAtomRemoteError | E>
  >;
};

const customerAtom = <E>(
  runtime: Atom.AtomRuntime<BillingAtomServices, E>,
  account: string,
): Atom.Atom<AsyncResult.AsyncResult<Customer | null, BillingAtomRemoteError | E>> => {
  const atom = runtime.atom(
    Effect.gen(function* () {
      const customers = yield* Customers(account);

      return yield* customers.get();
    }),
  );

  // SAFETY: the same runtime atom as `entitlementsAtom`, for the same reason.
  return atom as Atom.Atom<AsyncResult.AsyncResult<Customer | null, BillingAtomRemoteError | E>>;
};

const entitiesAtom = <E>(
  runtime: Atom.AtomRuntime<BillingAtomServices, E>,
  account: string,
): Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<Entity>, BillingAtomRemoteError | E>> => {
  const atom = runtime.atom(
    Effect.gen(function* () {
      const entities = yield* Entities(account);

      return yield* entities.list();
    }),
  );

  // SAFETY: the same runtime atom as `entitlementsAtom`, for the same reason.
  return atom as Atom.Atom<
    AsyncResult.AsyncResult<ReadonlyArray<Entity>, BillingAtomRemoteError | E>
  >;
};

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
 * import * as PaykitAtom from "@potion.run/paykit/Atom";
 * import * as AsyncResult from "effect/reactivity/AsyncResult";
 *
 * // No catalog: `startTrial` and `scheduleTierChange` name a plan, and the
 * // deployment expands it with the catalog its model was built with.
 * export const billing = PaykitAtom.make({
 *   url: "/api/billing",
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
const clientLayer = (
  options: BillingAtomUrlOptions,
): Layer.Layer<BillingClient | BillingCommands, never, never> => {
  const httpClient = options.httpClient ?? FetchHttpClient.layer;

  return Layer.mergeAll(
    BillingCommandsClient(options.commandsUrl ?? `${options.url}/commands`).pipe(
      Layer.provide(httpClient),
    ),
    BillingApi.layerClientHttp(options.url).pipe(Layer.provide(httpClient)),
  );
};

/** What building a URL client can fail with: nothing; both clients are built lazily. */
export type BillingAtomClientError = never;

export const make = <E = never>(options: BillingAtomOptions<E>): BillingAtoms<E> => {
  const chosen = "layer" in options ? options.layer : clientLayer(options);

  // SAFETY: both `make` forms name the same two services, and `clientLayer`
  // returns exactly that union for the URL form.
  const layer = chosen as Layer.Layer<BillingClient | BillingCommands, E, never>;

  const factory = options.runtime ?? Atom.runtime;

  const built = factory(
    // `provideMerge` keeps the Api client and the server join on the runtime, so
    // an application query — and a test that seeds a standing — can reach them
    // without rebuilding the transport.
    BillingApiLayer.pipe(Layer.provideMerge(layer)),
  );

  // SAFETY: `provideMerge` keeps the clients the layer built on the runtime.
  const runtime = built as Atom.AtomRuntime<BillingAtomServices, E>;

  const withAccount = (account: string) =>
    factory.withReactivity(["paykit", accountReactivityKey(account)]);

  // One atom per account: a component may call `billing.entitlements(id)` on
  // every render without handing `useAtomValue` a new atom each time.
  //
  // SAFETY: the Api client decodes a rejection into the schema `Instance<...>`
  // form; the public alias names the same class a caller matches, so the cast
  // keeps the atom's error channel readable at the call site.
  const entitlements = Atom.family((account: string): BillingQuery<EntitlementsState, E> =>
    Atom.withServerValueInitial(
      entitlementsAtom(runtime, account) as BillingQuery<EntitlementsState, E>,
    ).pipe(withAccount(account)),
  );

  // A balance is a read of the entitlement view: one query, mapped, so the
  // atom and `check` cannot describe different state.
  const balances = Atom.family((account: string): BillingQuery<ReadonlyArray<Balance>, E> =>
    Atom.map(entitlements(account), (result) =>
      AsyncResult.map(result, (state) => (state === null ? [] : balancesOf(state))),
    ),
  );

  const billing = Atom.family((account: string): BillingQuery<BillingStateView, E> =>
    Atom.withServerValueInitial(
      // SAFETY: the same alias as `entitlementsAtom`, for the same reason.
      billingAtom(runtime, account) as BillingQuery<BillingStateView, E>,
    ).pipe(withAccount(account)),
  );

  const customer = Atom.family((account: string): BillingQuery<Customer, E> =>
    Atom.withServerValueInitial(
      // SAFETY: the same alias as `entitlementsAtom`, for the same reason.
      customerAtom(runtime, account) as BillingQuery<Customer, E>,
    ).pipe(withAccount(account)),
  );

  const entities = Atom.family((account: string): BillingQuery<ReadonlyArray<Entity>, E> =>
    Atom.withServerValueInitial(
      // SAFETY: the same alias as `entitlementsAtom`, for the same reason.
      entitiesAtom(runtime, account) as BillingQuery<ReadonlyArray<Entity>, E>,
    ).pipe(withAccount(account)),
  );

  /**
   * One command over a bound verb. The binding sends the command and waits for
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

  const createBalance = Atom.family(
    (account: string): BillingMutation<BalanceCreateRequest, Balance, BalancesError, E> =>
      runtime.fn(
        (request: BalanceCreateRequest) =>
          Effect.gen(function* () {
            const bound = yield* Balances(account);

            return yield* bound.create(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.createBalance) },
      ),
  );

  const updateBalance = Atom.family(
    (account: string): BillingMutation<BalanceUpdateRequest, Balance, BalancesError, E> =>
      runtime.fn(
        (request: BalanceUpdateRequest) =>
          Effect.gen(function* () {
            const bound = yield* Balances(account);

            return yield* bound.update(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.updateBalance) },
      ),
  );

  const finalizeBalance = Atom.family(
    (account: string): BillingMutation<BalanceFinalizeRequest, Balance, BalancesError, E> =>
      runtime.fn(
        (request: BalanceFinalizeRequest) =>
          Effect.gen(function* () {
            const bound = yield* Balances(account);

            return yield* bound.finalize(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.finalizeBalance) },
      ),
  );

  const createEntity = Atom.family(
    (account: string): BillingMutation<EntityCreateRequest, Entity, EntitiesError, E> =>
      runtime.fn(
        (request: EntityCreateRequest) =>
          Effect.gen(function* () {
            const entities = yield* Entities(account);

            return yield* entities.create(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.createEntity) },
      ),
  );

  const updateEntity = Atom.family(
    (account: string): BillingMutation<EntityUpdateRequest, Entity, EntitiesError, E> =>
      runtime.fn(
        (request: EntityUpdateRequest) =>
          Effect.gen(function* () {
            const entities = yield* Entities(account);

            return yield* entities.update(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.updateEntity) },
      ),
  );

  const archiveEntity = Atom.family(
    (account: string): BillingMutation<EntityArchiveRequest, Entity, EntitiesError, E> =>
      runtime.fn(
        (request: EntityArchiveRequest) =>
          Effect.gen(function* () {
            const entities = yield* Entities(account);

            return yield* entities.archive(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.archiveEntity) },
      ),
  );

  const transferBalance = Atom.family(
    (
      account: string,
    ): BillingMutation<TransferBalanceRequest, TransferBalanceResult, TransferBalanceError, E> =>
      runtime.fn(
        (request: TransferBalanceRequest) =>
          Effect.gen(function* () {
            const transfer = yield* TransferBalance(account);

            return yield* transfer(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.transferBalance) },
      ),
  );

  const updateBillingControls = Atom.family(
    (account: string): BillingMutation<CustomerUpdateRequest, Customer, CustomersError, E> =>
      runtime.fn(
        (request: CustomerUpdateRequest) =>
          Effect.gen(function* () {
            const customers = yield* Customers(account);

            return yield* customers.update(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.updateBillingControls) },
      ),
  );

  const createCustomer = Atom.family(
    (account: string): BillingMutation<CustomerRequest, Customer, CustomersError, E> =>
      runtime.fn(
        (request: CustomerRequest) =>
          Effect.gen(function* () {
            const customers = yield* Customers(account);

            return yield* customers.create(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.createCustomer) },
      ),
  );

  const getOrCreateCustomer = Atom.family(
    (account: string): BillingMutation<CustomerRequest, Customer, CustomersError, E> =>
      runtime.fn(
        (request: CustomerRequest) =>
          Effect.gen(function* () {
            const customers = yield* Customers(account);

            return yield* customers.getOrCreate(request);
          }),
        { reactivityKeys: keysFor(account, options.reactivityKeys?.getOrCreateCustomer) },
      ),
  );

  return {
    runtime,
    entitlements,
    billing,
    balances,
    customer,
    entities,
    check,
    createBalance,
    updateBillingControls,
    createCustomer,
    getOrCreateCustomer,
    updateBalance,
    finalizeBalance,
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
    createEntity,
    updateEntity,
    archiveEntity,
    transferBalance,
  };
};
