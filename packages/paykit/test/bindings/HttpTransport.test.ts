import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { allowance } from "../../src/Allowance.ts";
import { DevGuards } from "../../src/Auth/FromHeaders.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { subscribeOperation } from "../../src/Billing/Subscribe.operation.ts";
import { TrackUsage } from "../../src/Billing/TrackUsage.binding.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const testCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [tier({ id: "free", grants: [allowance(messages, { included: 100 })] })],
  }),
);

const account = "acct_http";

/** The model and the guards the Api serves through. */
const base = Layer.mergeAll(
  PaykitModel.layer(PaykitHandlers).pipe(
    Layer.provideMerge(MemoryBillingReadStore),
    Layer.provide(Domain.InMemory),
    Layer.provideMerge(DevGuards),
    Layer.provideMerge(CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog)))),
    Layer.provideMerge(catalogLayer(testCatalog)),
  ),
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
);

/**
 * A real HTTP round trip against a served `BillingApi`: the outgoing request is
 * turned into a `Request`, handed to the Api's own `fetch`, and its response
 * turned back into a client response. Nothing is faked in between, so the Api's
 * `Session` middleware, its NDJSON framing and its reply decoding all run.
 */
const httpClient = (server: { readonly fetch: never }) =>
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

describe("the bindings over a real HTTP transport", () => {
  it.live("tracks and checks through a served Api, not through memory", () =>
    Effect.gen(function* () {
      // The account exists before the transport runs: this test is about the
      // wire, not about the purchase path.
      const subscribe = yield* subscribeOperation();
      yield* subscribe({ account, tier: "free" });

      const server = yield* BillingApi;
      const overTheWire = Layer.mergeAll(BillingApiLayer, catalogLayer(testCatalog)).pipe(
        Layer.provide(BillingApi.layerClientHttp("http://billing.test/api")),
        Layer.provideMerge(base),
        Layer.provide(Layer.succeed(BindingCall, { headers: { "x-paykit-actor": account } })),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient(server as never))),
      );

      yield* Effect.gen(function* () {
        const trackUsage = yield* TrackUsage(account);
        const recorded = yield* trackUsage({
          feature: "messages",
          amount: 40,
          dedupeKey: "over-http-1",
        });
        expect(recorded.remaining).toBe(60);
        expect(recorded.used).toBe(40);

        // Read-your-write survives the transport: the binding waited on the view
        // over the same Api before answering.
        const check = yield* Check(account);
        expect((yield* check({ feature: "messages", amount: 1 })).remaining).toBe(60);

        // A replay is a replay on the wire too.
        expect(
          (yield* trackUsage({ feature: "messages", amount: 40, dedupeKey: "over-http-1" })).used,
        ).toBe(40);

        // A refusal decodes back into the class a caller matches.
        const refused = yield* Effect.exit(
          trackUsage({ feature: "messages", amount: 61, dedupeKey: "over-http-2" }),
        );
        expect(refused._tag).toBe("Failure");
        if (refused._tag === "Failure") {
          expect(String(refused.cause)).toContain("AllowanceExceeded");
        }
      }).pipe(Effect.provide(overTheWire));

      // Nothing else wrote: the refusal left the standing where it was.
      const subscription = yield* Subscription;
      const state = yield* subscription.state(Subscription.ref(account));
      if (state._tag !== "Subscribed") throw new Error("expected a standing");
      expect(state.usage.messages).toBe(40);
    }).pipe(Effect.provide(base)),
  );
});
