import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import { NodeHttpServer } from "@effect/platform-node";
import { allowance, catalog, messages, tier } from "@potion.run/paykit";
import {
  AdminChangeTier,
  AdminChangeTierClient,
  AdminChangeTierHandlers,
  AdminConsoleRpcs,
  AdminReads,
  AdminReadsClient,
  AdminReadsHandlers,
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

const serverLayer = (handlers: {
  readonly reads: Effect.Success<typeof AdminReadsHandlers>;
  readonly changes: Effect.Success<typeof AdminChangeTierHandlers>;
}) =>
  HttpRouter.serve(
    RpcServer.layerHttp({
      group: AdminConsoleRpcs,
      path: "/console",
      protocol: "http",
    }).pipe(
      Layer.provide(AdminConsoleRpcs.toLayer({ ...handlers.reads, ...handlers.changes })),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(DevGuards),
    ),
  );

it.live("serves the admin reads over HTTP with the Admin guard", () =>
  Effect.gen(function* () {
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const client = AdminReadsClient("", {
      headers: admin,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(
      Layer.provideMerge(serverLayer({ reads, changes })),
      Layer.provide(NodeHttpServer.layerTest),
    );

    const catalog = yield* Effect.gen(function* () {
      const reads = yield* AdminReads;
      return yield* reads.catalog();
    }).pipe(Effect.provide(client));

    expect(catalog.tiers.map((entry) => entry.id)).toEqual(["free"]);
  }).pipe(Effect.provide(World)),
);

it.live("refuses a tenant session on the console reads", () =>
  Effect.gen(function* () {
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const client = AdminReadsClient("", {
      headers: tenant,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(
      Layer.provideMerge(serverLayer({ reads, changes })),
      Layer.provide(NodeHttpServer.layerTest),
    );

    const exit = yield* Effect.gen(function* () {
      const reads = yield* AdminReads;
      return yield* Effect.exit(reads.catalog());
    }).pipe(Effect.provide(client));

    expect(String(exit)).toContain("Forbidden");
  }).pipe(Effect.provide(World)),
);

it.live("routes the tier-change RPC through the same server group", () =>
  Effect.gen(function* () {
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const client = AdminChangeTierClient("", {
      headers: admin,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(
      Layer.provideMerge(serverLayer({ reads, changes })),
      Layer.provide(NodeHttpServer.layerTest),
    );

    const answer = yield* Effect.gen(function* () {
      const change = yield* AdminChangeTier;
      return yield* change.change({ account: "acct_1", tier: "free" });
    }).pipe(Effect.provide(client));

    expect(answer._tag).toBe("rejected");
    if (answer._tag === "rejected") expect(answer.rejection._tag).toBe("NotSubscribed");
  }).pipe(Effect.provide(World)),
);
