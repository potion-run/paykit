import { describe, expect, it } from "@alchemy.run/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Paykit, Subscription } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { Provider } from "../src/billing.config.ts";
import { MemoryLive } from "../src/Billing.layer.ts";
import { billingCatalog, free, messages } from "../src/catalog.ts";

const account = Subscription.ref("acct_node_example");

/**
 * The same handler the process serves, on a real `node:http` server on an
 * ephemeral port, plus the fetch-backed client `layerTest` points at it. This
 * is the host proof: no Worker runtime, no fetch handler, no deploy resource.
 */
const Served = Layer.unwrap(
  Effect.map(
    Paykit.handler({
      provider: Provider,
      accountOf: (request) => Paykit.accountFromHeaders(request.headers),
      surfaces: "tenant",
    }),
    (handler) => HttpServer.serve()(handler.fetch),
  ),
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(MemoryLive));

describe("the Node host", () => {
  it.live("serves a purchase over HTTP", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.get("/checkout?tier=pro").pipe(
          HttpClientRequest.setHeader("x-paykit-actor", account.id),
        ),
      );

      expect(response.status).toBe(200);
      expect(yield* response.text).toContain("invoiceId");
    }).pipe(Effect.provide(Served)),
  );

  it.live("answers 401 when the request names no account", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(HttpClientRequest.get("/checkout?tier=pro"));

      expect(response.status).toBe(401);
    }).pipe(Effect.provide(Served)),
  );
});

describe("the model the host serves", () => {
  it.live("sells a free tier, records usage and answers the next check", () =>
    Effect.gen(function* () {
      const subscribe = yield* Paykit.Subscribe(account.id);

      expect(yield* subscribe({ tier: free.id })).toEqual({ activated: true });

      const track = yield* Paykit.TrackUsage(account.id);
      yield* track({ featureId: messages.id, value: 5, idempotencyKey: "req_1" });

      const check = yield* Paykit.Check(account.id);
      const answer = yield* check({ featureId: messages.id, requiredBalance: 1 });

      expect(answer.allowed).toBe(true);
      expect(answer.balance.remaining).toBe(95);
      expect(answer.standing).toBe("good");
    }).pipe(Effect.provide(MemoryLive)),
  );

  it("the catalog is plain data, not a host detail", () => {
    expect(billingCatalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro"]);
    expect(billingCatalog.features.map((feature) => feature.id)).toEqual(["messages"]);
  });
});
