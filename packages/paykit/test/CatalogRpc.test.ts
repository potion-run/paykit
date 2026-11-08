import { expect, it } from "@alchemy.run/test";
import { NodeHttpServer } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { allowance } from "../src/Allowance.ts";
import { InsecureDevGuards } from "../src/Auth/FromHeaders.ts";
import { type Catalog, catalog } from "../src/Catalog.ts";
import {
  PaykitCatalogClient,
  PaykitCatalogHandlers,
  PaykitCatalogRpcs,
  PaykitCatalogServer,
} from "../src/CatalogRpc.ts";
import { CatalogService, catalogLayer } from "../src/CatalogService.ts";
import { messages } from "../src/Feature.ts";
import { tier } from "../src/Tier.ts";

const pro = tier({
  id: "pro",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  credits: 50_000,
  // A duration is the one catalog value that is not a JSON primitive, so the
  // encoding is proven rather than assumed.
  topUp: { threshold: 5_000, cooldown: Duration.minutes(30), pack: "credits_100k" },
  grants: [allowance(messages, { included: 2_000, overage: "bill" })],
});

const pack = tier({
  id: "credits_100k",
  kind: "one_off",
  price: { amount: 4_900, currency: "usd", interval: "month" },
  credits: 100_000,
  grants: [],
});

const deployCatalog: Catalog = Effect.runSync(
  catalog({ features: [messages], tiers: [pro, pack] }),
);

const actor = { "x-paykit-actor": "acct_1" };

const serve = (handlers: Effect.Success<typeof PaykitCatalogHandlers>) =>
  HttpRouter.serve(
    RpcServer.layerHttp({
      group: PaykitCatalogRpcs,
      path: "/api/billing/catalog",
      protocol: "http",
    }).pipe(
      Layer.provide(PaykitCatalogRpcs.toLayer(handlers)),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(InsecureDevGuards),
    ),
  );

/** A client over a served copy of `deployCatalog`, providing its own `CatalogService`. */
const client = (
  handlers: Effect.Success<typeof PaykitCatalogHandlers>,
  headers: Record<string, string> = actor,
) =>
  PaykitCatalogClient("", {
    headers,
    transformClient: (httpClient) =>
      HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/api/billing/catalog")),
  }).pipe(Layer.provideMerge(serve(handlers)), Layer.provide(NodeHttpServer.layerTest));

/** Build a client layer and read the catalog it provides out of the result. */
const servedFrom = (handlers: Effect.Success<typeof PaykitCatalogHandlers>, headers?: {}) =>
  Layer.build(client(handlers, headers)).pipe(
    Effect.map((context) => Context.get(context, CatalogService)),
  );

const deployHandlers = Effect.provide(PaykitCatalogHandlers, catalogLayer(deployCatalog));

it.live("serves the deploy's catalog, whole, to a signed-in caller", () =>
  Effect.gen(function* () {
    const handlers = yield* deployHandlers;
    const served = yield* servedFrom(handlers);

    // A browser joins a tier's terms from this, so anything missing here is a
    // command the server would refuse with `CatalogMismatch`.
    expect(served).toEqual(deployCatalog);
    expect(served.tiers[0]?.topUp?.cooldown).toEqual(Duration.minutes(30));
    expect(served.tiers[0]?.topUp?.pack).toBe("credits_100k");
  }),
);

it.live("refuses a caller with no session, so the catalog is not a public read", () =>
  Effect.gen(function* () {
    const handlers = yield* deployHandlers;
    const outcome = yield* Effect.result(servedFrom(handlers, {}));
    expect(outcome._tag).toBe("Failure");

    if (outcome._tag !== "Failure") return;
    expect(outcome.failure._tag).toBe("Unauthenticated");
  }),
);

it.live("builds the server from a world that provides the catalog and a guard", () =>
  Effect.gen(function* () {
    const server = yield* PaykitCatalogServer;
    expect(server).toBeDefined();
  }).pipe(Effect.provide(Layer.mergeAll(catalogLayer(deployCatalog), InsecureDevGuards))),
);
