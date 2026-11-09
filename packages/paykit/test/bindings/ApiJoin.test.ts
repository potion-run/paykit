import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import { ScheduleCancellation } from "../../src/Billing/Cancel.binding.ts";
import {
  BillingCommandsClient,
  BillingCommandsLive,
  BillingCommandsServer,
} from "../../src/Billing/Commands.rpc.ts";
import { ScheduleTierChange } from "../../src/Billing/ScheduleTierChange.binding.ts";
import { SetBillingControls } from "../../src/Billing/SetBillingControls.binding.ts";
import { StartTrial } from "../../src/Billing/StartTrial.binding.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { handler } from "../../src/Handler.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { DEFAULT_PLAN_GROUP } from "../../src/Subscription/PlanSet.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { pendingPlanOf, planRowsOf } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import { world } from "../../src/World.ts";

const free = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });

const pro = tier({
  id: "pro",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  credits: 5_000,
  grants: [allowance(messages, { included: 2_000, overage: "bill" })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [free, pro] }));

const account = Subscription.ref("acct_api_join");
const asAccount = { headers: { "x-paykit-actor": account.id } };

const Model = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InsecureDevGuards,
        CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
      ),
    ),
  );

/** The deployment: one model, one catalog, and the server-side join. */
const Server = BillingCommandsLive.pipe(
  Layer.provideMerge(Model),
  Layer.provideMerge(catalogLayer(testCatalog)),
);

/** A server response as an `HttpClient`, so the clients speak the real wire. */
const httpClient = (
  serve: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>,
) =>
  HttpClient.make(
    (request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request);
        const incoming = HttpServerRequest.fromWeb(web);

        const served = yield* serve(incoming).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, incoming),
          Effect.scoped,
        );

        return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(served));
      }) as never,
  );

/** The Api and the commands on one base, so one client can reach both. */
const routed =
  (
    api: Effect.Success<typeof BillingApi>,
    commands: Effect.Success<typeof BillingCommandsServer>,
  ) =>
  (request: HttpServerRequest.HttpServerRequest) => {
    const path = new URL(request.url, "http://billing.test").pathname;

    return path.startsWith("/api/commands") ? commands : api.fetch;
  };

const trialDeadline = DateTime.add(DateTime.makeUnsafe(Date.now()), { days: 14 });

it.live("a client with no catalog starts a trial and schedules a change through the Api", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Server);
    const api = yield* BillingApi.pipe(Effect.provide(context));
    const commands = yield* BillingCommandsServer.pipe(Effect.provide(context));

    // No `catalogLayer` here: the client sends the plan id and the deployment
    // expands it. The only catalog in this test is the one the server holds.
    const Client = BillingApiLayer.pipe(
      Layer.provideMerge(BillingCommandsClient("http://billing.test/api/commands")),
      Layer.provide(BillingApi.layerClientHttp("http://billing.test/api")),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient(routed(api, commands)))),
      Layer.provide(Layer.succeed(BindingCall, asAccount)),
    );

    yield* Effect.gen(function* () {
      const startTrial = yield* StartTrial(account.id);

      const started = yield* startTrial({
        tier: "pro",
        trialEndsAt: trialDeadline,
        dedupeKey: "join-trial",
      });

      expect(started.tier).toBe("pro");
      expect(started.status).toBe("trialing");

      const schedule = yield* ScheduleTierChange(account.id);

      expect((yield* schedule({ tier: "free", dedupeKey: "join-schedule" })).pendingTier).toBe(
        "free",
      );

      // A controls write carries no catalog feature facts from the client; the
      // view it answers came back over the same wire.
      const controls = yield* SetBillingControls(account.id);

      const written = yield* controls({
        billingControls: { usageAlerts: [{ featureId: "messages", at: 500 }] },
      });

      expect(written.view?.billingControls?.usageAlerts?.[0]?.at).toBe(500);

      const cancel = yield* ScheduleCancellation(account.id);
      expect((yield* cancel({ dedupeKey: "join-cancel" })).cancelAtPeriodEnd).toBe(true);

      // A refusal crosses the same wire as a success; the client matches the
      // model's class, not a transport error.
      const again = yield* Effect.exit(
        startTrial({
          tier: "pro",
          trialEndsAt: trialDeadline,
          dedupeKey: "join-trial-again",
        }),
      );

      expect(again._tag).toBe("Failure");

      if (again._tag === "Failure") {
        expect(String(again.cause)).toContain("TrialAlreadyUsed");
      }
    }).pipe(Effect.provide(Client));

    const subscription = Context.get(context, Subscription);
    const state = yield* subscription.state(account);

    if (state._tag !== "Subscribed") return yield* Effect.die(new Error("expected a standing"));

    // The command the server sent carries the catalog's terms, not a client's.
    const proTerms = planTermsOf(testCatalog, "pro");
    const row = planRowsOf(state)[0];

    expect(proTerms).not.toBeNull();
    expect(row?.planId).toBe("pro");
    expect(row?.allowances).toEqual(proTerms?.allowances);
    expect(row?.credits).toBe(proTerms?.credits);
    expect(row?.price).toEqual(proTerms?.price);

    const freeTerms = planTermsOf(testCatalog, "free");
    const phase = pendingPlanOf(state, DEFAULT_PLAN_GROUP);

    expect(freeTerms).not.toBeNull();
    expect(phase?.planId).toBe("free");
    expect(phase?.allowances).toEqual(freeTerms?.allowances);
    expect(phase?.credits).toBe(freeTerms?.credits);
  }),
);

it.live("the handler mounts the join without building a second model", () =>
  Effect.gen(function* () {
    const serve = yield* handler({
      accountOf: (request) => request.headers["x-paykit-actor"] ?? null,
      surfaces: "tenant",
    });

    const client = BillingCommandsClient("http://billing.test/api/commands", {
      headers: asAccount.headers,
    }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient(serve))));

    yield* Effect.gen(function* () {
      const startTrial = yield* StartTrial(account.id);

      yield* startTrial({
        tier: "pro",
        trialEndsAt: trialDeadline,
        dedupeKey: "handler-trial",
      });
    }).pipe(Effect.provide(client));

    // The handler requires the model; it never builds one. This read is the
    // same aggregate the command wrote through the mounted route.
    const subscription = yield* Subscription;
    const state = yield* subscription.state(account);

    expect(state._tag).toBe("Subscribed");

    if (state._tag === "Subscribed") {
      expect(planRowsOf(state)[0]?.planId).toBe("pro");
    }
  }).pipe(
    Effect.provide(
      world({
        catalog: testCatalog,
        guards: InsecureDevGuards,
        bindings: "both",
      }),
    ),
  ),
);
