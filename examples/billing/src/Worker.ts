import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { BillingAdminApi, BillingApi, type D1Like } from "@potion.run/paykit";
import { BillingMcp } from "@potion.run/paykit/Surfaces";
import { McpProtocol, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { BillingDatabase } from "./Database.ts";
import { type BillingOnSql, billingOnSql } from "./SqlBilling.ts";

/** The three paths, served from one model hosted on one database. */
const serve = (billing: BillingOnSql) =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi;
    const admin = yield* BillingAdminApi;
    // The MCP server is a web handler, not an Effect fetch, so it is built once
    // from the same layers the Worker serves.
    const mcp = HttpRouter.toWebHandler(
      BillingMcp.pipe(
        Layer.provide(
          McpServer.layerHttp({
            name: "paykit",
            version: "0.1.0",
            path: "/mcp",
            protocols: [McpProtocol.v2025_11_25],
          }),
        ),
        Layer.provide(billing.world),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(mcp.dispose));
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/mcp") {
          const response = yield* Effect.promise(() => mcp.handler(request.source as Request));
          return HttpServerResponse.fromWeb(response);
        }
        if (path.startsWith("/api")) return yield* tenant.fetch;
        if (path.startsWith("/admin")) return yield* admin.fetch;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(billing.world));

/**
 * One Worker, three paths, one model, one database:
 *
 * - `/api`   — `BillingApi`, the tenant surface. A signed-in account, scoped to itself.
 * - `/admin` — `BillingAdminApi`, the ops console. An operator session.
 * - `/mcp`   — the same tenant Api as MCP tools, derived by `DomainAi.toMcp`.
 *
 * The model runs on the database declared beside this Worker: the event log,
 * every read model and the entitlement a `check()` answers from live in one
 * schema, and the migration file that creates it is generated from paykit's own
 * DDL, so a test and a release cannot disagree about the tables.
 *
 * The MCP server is the Api, not a second copy of it, so each tool call runs the
 * Api's own `Session` middleware with the MCP request's headers: an agent can
 * only reach what the account it acts for can reach.
 */
export default class BillingWorker extends Cloudflare.Worker<BillingWorker>()(
  "BillingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(BillingDatabase);
    // The binding is the only platform-specific piece: everything above it is
    // the same store a test runs on a file.
    return yield* serve(billingOnSql(database as unknown as D1Like));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(DomainCloudflare.layerDurableObjects(), Cloudflare.D1.QueryDatabaseBinding),
    ),
    Effect.orDie,
  ),
) {}
