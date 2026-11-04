import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { BillingAdminApi, BillingApi } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { BillingLayers } from "./Billing.ts";
import { toMcpHandler } from "./Mcp.ts";

/**
 * One Worker, three paths, one model:
 *
 * - `/api`   — `BillingApi`, the tenant surface. A signed-in account, scoped to itself.
 * - `/admin` — `BillingAdminApi`, the ops console. An operator session.
 * - `/mcp`   — the same tenant Api as MCP tools, derived by `DomainAi.toMcp`.
 *
 * The MCP server is the Api, not a second copy of it: `BillingMcp` is
 * `DomainAi.toMcp(BillingApi)`, so each tool call runs the Api's own `Session`
 * middleware with the MCP request's headers and an agent can only reach what
 * the account it acts for can reach. There is no tool list to keep in step.
 */
export default class BillingWorker extends Cloudflare.Worker<BillingWorker>()(
  "BillingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const tenant = yield* BillingApi;
    const admin = yield* BillingAdminApi;
    // The MCP server is a web handler, not an Effect fetch, so it is built
    // once from the same layers the Worker serves.
    const mcp = yield* toMcpHandler;
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
  }).pipe(
    // The guards are the development ones. A real deployment provides a
    // `Session` Layer over its own session and keeps `Admin` stricter still.
    // One `provide` of a composed layer, not a chain: `Layer.provide` wires
    // `layerDurableObjects` into `BillingLayers`' requirements, which a
    // `Layer.mergeAll` beside it would not.
    Effect.provide(
      Layer.orDie(BillingLayers).pipe(Layer.provide(DomainCloudflare.layerDurableObjects())),
    ),
    Effect.orDie,
  ),
) {}
