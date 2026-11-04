import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import { NodeHttpServer } from "@effect/platform-node";
import { allowance, catalog, messages, tier } from "@potion.run/paykit";
import {
  AdminReads,
  AdminReadsClient,
  AdminReadsHandlers,
  AdminReadsRpcs,
} from "@potion.run/paykit/Admin";
import { Actor, system } from "@potion.run/paykit/Auth/Actor";
import { DevGuards } from "@potion.run/paykit/Auth/FromHeaders";
import { MemoryBillingReadStore } from "@potion.run/paykit/BillingReadStore";
import { catalogLayer } from "@potion.run/paykit/CatalogService";
import { PaykitHandlers, PaykitModel } from "@potion.run/paykit/Paykit.model";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier] }));

const World = Layer.mergeAll(
  PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
    .pipe(Layer.provide(Domain.InMemory))
    .pipe(Layer.provideMerge(MemoryBillingReadStore)),
  catalogLayer(testCatalog),
  Layer.succeed(Actor, system("test")),
);

const admin = {
  "x-paykit-actor": "ops_1",
  "x-paykit-kind": "admin",
};
const tenant = {
  "x-paykit-actor": "acct_1",
};

const serverLayer = (handlers: Effect.Success<typeof AdminReadsHandlers>) =>
  HttpRouter.serve(
    RpcServer.layerHttp({
      group: AdminReadsRpcs,
      path: "/console",
      protocol: "http",
    }).pipe(
      Layer.provide(AdminReadsRpcs.toLayer(handlers)),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(DevGuards),
    ),
  );

it.live("serves the admin reads over HTTP with the Admin guard", () =>
  Effect.gen(function* () {
    const handlers = yield* AdminReadsHandlers;
    const client = AdminReadsClient("", {
      headers: admin,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(Layer.provideMerge(serverLayer(handlers)), Layer.provide(NodeHttpServer.layerTest));

    const catalog = yield* Effect.gen(function* () {
      const reads = yield* AdminReads;
      return yield* reads.catalog();
    }).pipe(Effect.provide(client));

    expect(catalog.tiers.map((entry) => entry.id)).toEqual(["free"]);
  }).pipe(Effect.provide(World)),
);

it.live("refuses a tenant session on the console reads", () =>
  Effect.gen(function* () {
    const handlers = yield* AdminReadsHandlers;
    const client = AdminReadsClient("", {
      headers: tenant,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(Layer.provideMerge(serverLayer(handlers)), Layer.provide(NodeHttpServer.layerTest));

    const exit = yield* Effect.gen(function* () {
      const reads = yield* AdminReads;
      return yield* Effect.exit(reads.catalog());
    }).pipe(Effect.provide(client));

    expect(String(exit)).toContain("Forbidden");
  }).pipe(Effect.provide(World)),
);
