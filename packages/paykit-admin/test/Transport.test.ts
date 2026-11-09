import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import { NodeHttpServer } from "@effect/platform-node";
import {
  planItem,
  catalog,
  messages,
  plan,
  Actor,
  system,
  BillingAdminInProcess,
  InsecureDevGuards,
  PaykitHandlers,
  PaykitModel,
  Memory,
  paymentsRouter,
} from "@potion.run/paykit";
import {
  AdminChangeTier,
  AdminChangeTierClient,
  AdminChangeTierHandlers,
  AdminConsoleRpcs,
  AdminConsoleServer,
  AdminReads,
  AdminReadsClient,
  AdminReadsHandlers,
  AdminRefund,
  AdminRefundClient,
  AdminRefundHandlers,
} from "@potion.run/paykit/Admin";
import { MemoryBillingReadStore, catalogLayer } from "@potion.run/paykit/Read";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

const freeTier = plan({ id: "free", grants: [planItem(messages, { included: 100 })] });
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier] }));

const Model = PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(Layer.provideMerge(MemoryBillingReadStore));

/**
 * The console server's world. The refund RPC runs the in-process admin
 * binding, so the model and a money provider are here beside the read store.
 */
const World = Layer.mergeAll(
  BillingAdminInProcess,
  catalogLayer(testCatalog),
  Layer.succeed(Actor, system("test")),
  InsecureDevGuards,
).pipe(Layer.provideMerge(Model), Layer.provide(paymentsRouter(Memory())));

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
  readonly refunds: Effect.Success<typeof AdminRefundHandlers>;
}) =>
  HttpRouter.serve(
    RpcServer.layerHttp({
      group: AdminConsoleRpcs,
      path: "/console",
      protocol: "http",
    }).pipe(
      Layer.provide(
        AdminConsoleRpcs.toLayer({
          ...handlers.reads,
          ...handlers.changes,
          ...handlers.refunds,
        }),
      ),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(InsecureDevGuards),
    ),
  );

it.live("builds the console server from the hosted model and admin guard", () =>
  Effect.gen(function* () {
    const server = yield* AdminConsoleServer;
    expect(server).toBeDefined();
  }).pipe(Effect.provide(World)),
);

it.live("serves the admin reads over HTTP with the Admin guard", () =>
  Effect.gen(function* () {
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const refunds = yield* AdminRefundHandlers;

    const client = AdminReadsClient("", {
      headers: admin,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(
      Layer.provideMerge(serverLayer({ reads, changes, refunds })),
      Layer.provide(NodeHttpServer.layerTest),
    );

    const catalog = yield* Effect.gen(function* () {
      const reads = yield* AdminReads;

      return yield* reads.catalog();
    }).pipe(Effect.provide(client));

    expect(catalog.tiers.map((entry) => entry.id)).toEqual(["free"]);

    const providerRefs = yield* Effect.gen(function* () {
      const reads = yield* AdminReads;

      return yield* reads.providerRefs("acct_1");
    }).pipe(Effect.provide(client));

    expect(providerRefs.account).toBe("acct_1");
    expect(providerRefs.refs).toEqual({});

    const overview = yield* Effect.gen(function* () {
      const reads = yield* AdminReads;

      return yield* reads.overview();
    }).pipe(Effect.provide(client));

    expect(overview.accounts).toBe(0);
  }).pipe(Effect.provide(World)),
);

it.live("refuses a tenant session on the console reads", () =>
  Effect.gen(function* () {
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const refunds = yield* AdminRefundHandlers;

    const client = AdminReadsClient("", {
      headers: tenant,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(
      Layer.provideMerge(serverLayer({ reads, changes, refunds })),
      Layer.provide(NodeHttpServer.layerTest),
    );

    const exit = yield* Effect.gen(function* () {
      const reads = yield* AdminReads;

      return yield* Effect.exit(reads.catalog());
    }).pipe(Effect.provide(client));

    expect(String(exit)).toContain("Forbidden");
  }).pipe(Effect.provide(World)),
);

it.live("routes the plan-change RPC through the same server group", () =>
  Effect.gen(function* () {
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const refunds = yield* AdminRefundHandlers;

    const client = AdminChangeTierClient("", {
      headers: admin,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(
      Layer.provideMerge(serverLayer({ reads, changes, refunds })),
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

it.live("routes the refund RPC through the same server group", () =>
  Effect.gen(function* () {
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const refunds = yield* AdminRefundHandlers;

    const client = AdminRefundClient("", {
      headers: admin,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(
      Layer.provideMerge(serverLayer({ reads, changes, refunds })),
      Layer.provide(NodeHttpServer.layerTest),
    );

    const answer = yield* Effect.gen(function* () {
      const refund = yield* AdminRefund;

      return yield* refund.refund({
        account: "acct_1",
        chargeId: "ch_1",
        amount: 100,
        currency: "usd",
        commandId: "refund-1",
      });
    }).pipe(Effect.provide(client));

    // Nothing was charged, so the binding refuses before it asks the provider.
    expect(answer._tag).toBe("rejected");

    if (answer._tag === "rejected") expect(answer.rejection._tag).toBe("RefundExceedsCharged");
  }).pipe(Effect.provide(World)),
);

it.live("refuses a tenant session on the refund RPC", () =>
  Effect.gen(function* () {
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const refunds = yield* AdminRefundHandlers;

    const client = AdminRefundClient("", {
      headers: tenant,
      transformClient: (httpClient) =>
        HttpClient.mapRequest(httpClient, HttpClientRequest.appendUrl("/console")),
    }).pipe(
      Layer.provideMerge(serverLayer({ reads, changes, refunds })),
      Layer.provide(NodeHttpServer.layerTest),
    );

    const exit = yield* Effect.gen(function* () {
      const refund = yield* AdminRefund;

      return yield* Effect.exit(
        refund.refund({
          account: "acct_1",
          chargeId: "ch_1",
          amount: 100,
          currency: "usd",
          commandId: "refund-2",
        }),
      );
    }).pipe(Effect.provide(client));

    expect(String(exit)).toContain("Forbidden");
  }).pipe(Effect.provide(World)),
);
