import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Scope from "effect/Scope";
import { allowance } from "../src/Allowance.ts";
import * as PaykitAtom from "../src/Atom.ts";
import { InsecureDevGuards } from "../src/Auth/FromHeaders.ts";
import { BindingCall } from "../src/Billing/Bindings.ts";
import { BillingApi } from "../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../src/BillingReadStore.ts";
import { catalog, tierTermsOf } from "../src/Catalog.ts";
import { CatalogGuardLive } from "../src/CatalogGuard.ts";
import { catalogLayer } from "../src/CatalogService.ts";
import { messages } from "../src/Feature.ts";
import { PaykitHandlers, PaykitModel as Model } from "../src/Paykit.model.ts";
import { PaymentsManual } from "../src/PaymentsManual.ts";
import { Subscription } from "../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../src/Tier.ts";

const free = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });

const pro = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 1_000, overage: "bill" })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [free, pro] }));

const account = "acct_atom";
const actorHeader = { "x-paykit-actor": account };

const Provider = PaymentsManual();

/**
 * The model, the catalog and the development guard. It is the same world the
 * examples build; the atom client only ever sees the Api client and the
 * catalog, so the transport can be swapped without touching this test.
 */
const World = Layer.mergeAll(
  CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
  Provider.payments,
).pipe(
  Layer.provideMerge(InsecureDevGuards),
  Layer.provideMerge(Model.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))),
  Layer.provideMerge(MemoryBillingReadStore),
  Layer.provideMerge(catalogLayer(testCatalog)),
  Layer.provideMerge(Domain.InMemory),
);

/** The in-process Api client the atom runtime is built on, with the account's headers. */
const ClientLayer = BillingApi.layerClientInProcess.pipe(
  Layer.provide(World),
  Layer.provideMerge(catalogLayer(testCatalog)),
  Layer.provideMerge(Layer.succeed(BindingCall, { headers: actorHeader })),
);

/**
 * A real HTTP round trip against a served `BillingApi`: the outgoing request is
 * turned into a `Request`, handed to the Api's own `fetch`, and its response
 * turned back into a client response. Nothing is faked in between, so the Api's
 * `Session` middleware, its NDJSON framing and its reply decoding all run.
 */
const httpClient = (server: { readonly fetch: unknown }) =>
  HttpClient.make(
    (request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request);

        const served = yield* (
          server.fetch as unknown as Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            never,
            HttpServerRequest.HttpServerRequest | Scope.Scope
          >
        ).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(web),
          ),
          Effect.scoped,
        );

        return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(served));
      }) as never,
  );

/** Wait until an effect-backed atom stops waiting, then return its result. */
const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Effect.Effect<AsyncResult.AsyncResult<A, E>> =>
  Effect.gen(function* () {
    const latch = Latch.makeUnsafe();
    const current = registry.get(atom);

    if (!current.waiting && current._tag !== "Initial") return current;

    const unsubscribe = registry.subscribe(atom, (value) => {
      if (!value.waiting && value._tag !== "Initial") latch.openUnsafe();
    });

    yield* latch.await;
    yield* Effect.sync(unsubscribe);

    return registry.get(atom);
  });

/** A successful value, or the cause the atom failed with. */
const valueOf = <A, E>(result: AsyncResult.AsyncResult<A, E>): Effect.Effect<A, E> => {
  if (AsyncResult.isSuccess(result)) return Effect.succeed(result.value);

  if (AsyncResult.isFailure(result)) return Effect.failCause(result.cause);

  return Effect.die(new Error("the atom did not settle"));
};

/**
 * Seed a standing through the same Api client the runtime holds. The atom
 * surface is the tenant commands; a purchase is an operation the deployment
 * owns, so the test starts from a standing the way a checkout would leave one.
 */
const seedStanding = <E>(
  registry: AtomRegistry.AtomRegistry,
  billing: PaykitAtom.BillingAtoms<E>,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    // Keep the runtime mounted: it owns the layer (and the in-memory model)
    // the test's queries read from.
    registry.mount(billing.runtime);
    const built = yield* settled(registry, billing.runtime);
    const context = yield* valueOf(built);
    const client = Context.get(context, BillingApi.Client);
    const terms = tierTermsOf(testCatalog, "free");

    if (terms === null) return yield* Effect.die(new Error("the test catalog has no free tier"));

    const receipt = yield* client
      .Subscribe(Subscription.ref(account).id, { tier: "free", ...terms }, { headers: actorHeader })
      .pipe(Effect.orDie);

    // The purchase is a command; wait on the view it committed before the
    // query reads, exactly as the binding would after a tracked usage.
    yield* client.Entitlements.get(Subscription.ref(account).id, {
      atLeast: receipt,
      headers: actorHeader,
    }).pipe(Effect.orDie);
  });

it.live("a command refreshes the account's views without a manual subscription", () =>
  Effect.gen(function* () {
    const billing = PaykitAtom.make({ layer: ClientLayer });
    const registry = AtomRegistry.make();
    const entitlements = billing.entitlements(account);

    yield* seedStanding(registry, billing);
    const unmountEntitlements = registry.mount(entitlements);
    yield* Effect.addFinalizer(() => Effect.sync(unmountEntitlements));

    const afterSubscribe = yield* valueOf(yield* settled(registry, entitlements));
    expect(afterSubscribe?.tier).toBe("free");
    expect(afterSubscribe?.features.messages?.remaining).toBe(100);

    const trackUsage = billing.trackUsage(account);
    const unmountTrack = registry.mount(trackUsage);
    yield* Effect.addFinalizer(() => Effect.sync(unmountTrack));
    registry.set(trackUsage, { feature: "messages", amount: 40, dedupeKey: "atom-usage-1" });
    const recorded = yield* valueOf(yield* settled(registry, trackUsage));
    expect(recorded).toEqual({ remaining: 60, used: 40, reserved: 0, credits: 0, cost: 0 });

    // The mutation refreshed the view; no `refresh` call anywhere in the test.
    const afterUsage = yield* valueOf(yield* settled(registry, entitlements));
    expect(afterUsage?.features.messages?.remaining).toBe(60);
    expect(afterUsage?.features.messages?.used).toBe(40);
  }),
);

it.live("check is a command atom, so the amount is part of the question", () =>
  Effect.gen(function* () {
    const billing = PaykitAtom.make({ layer: ClientLayer });
    const registry = AtomRegistry.make();
    const check = billing.check(account);

    yield* seedStanding(registry, billing);
    const unmountCheck = registry.mount(check);
    yield* Effect.addFinalizer(() => Effect.sync(unmountCheck));

    registry.set(check, { feature: "messages", amount: 100 });
    const allowed = yield* valueOf(yield* settled(registry, check));
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(100);

    const trackUsage = billing.trackUsage(account);
    const unmountTrack = registry.mount(trackUsage);
    yield* Effect.addFinalizer(() => Effect.sync(unmountTrack));
    registry.set(trackUsage, { feature: "messages", amount: 95, dedupeKey: "atom-usage-2" });
    yield* valueOf(yield* settled(registry, trackUsage));

    // Reset the command's previous answer before asking again; an AtomResultFn
    // keeps its last result until the next write.
    registry.set(check, Atom.Reset);
    registry.set(check, { feature: "messages", amount: 10 });
    const refused = yield* valueOf(yield* settled(registry, check));
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(5);
  }),
);

it.live("a foreign account is a typed failure, not a second account's read", () =>
  Effect.gen(function* () {
    const billing = PaykitAtom.make({ layer: ClientLayer });
    const registry = AtomRegistry.make();
    const foreign = billing.entitlements("acct_someone_else");
    const unmount = registry.mount(foreign);
    yield* Effect.addFinalizer(() => Effect.sync(unmount));

    const result = yield* settled(registry, foreign);
    expect(AsyncResult.isFailure(result)).toBe(true);

    if (AsyncResult.isFailure(result)) {
      const error = Cause.findErrorOption(result.cause);
      expect(String(error)).toContain("Forbidden");
    }
  }),
);

it.live("the atom client speaks the Api's HTTP protocol", () =>
  Effect.gen(function* () {
    const server = yield* BillingApi;

    // The request carries a different actor than the account it targets, so
    // the Api's Session guard refuses it over the wire; the atom decodes the
    // refusal into the class a caller matches, not a transport error.
    const HttpAtoms = Layer.mergeAll(
      catalogLayer(testCatalog),
      BillingApi.layerClientHttp("http://billing.test/api").pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient(server))),
        Layer.provideMerge(
          Layer.succeed(BindingCall, { headers: { "x-paykit-actor": "acct_someone_else" } }),
        ),
      ),
    );

    const billing = PaykitAtom.make({ layer: HttpAtoms });
    const registry = AtomRegistry.make();
    const trackUsage = billing.trackUsage(account);
    const unmount = registry.mount(trackUsage);
    yield* Effect.addFinalizer(() => Effect.sync(unmount));

    registry.set(trackUsage, { feature: "messages", amount: 1, dedupeKey: "http-atom" });
    const result = yield* settled(registry, trackUsage);
    expect(AsyncResult.isFailure(result)).toBe(true);

    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(String(error)).toContain("Forbidden");
    }
  }).pipe(Effect.provide(World)),
);
