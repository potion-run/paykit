import * as DomainAi from "@alchemy.run/domain/Ai";
import * as DomainCli from "@alchemy.run/domain/Cli";
import { BillingAdminApi } from "./BillingAdminApi.api.ts";
import { BillingApi } from "./BillingApi.api.ts";

/**
 * The surfaces an Api projects onto, without a second declaration.
 *
 * This module is a separate entry point (`@potion.run/paykit/Surfaces`)
 * because it loads `effect/ai` and `effect/cli`. An app that serves only HTTP
 * never imports it, and never pays for them.
 *
 * An Api is the unit of authorization: `toMcp` runs every tool call through
 * the Api's own middleware, using the MCP request's headers, so the tenant MCP
 * server authenticates exactly as the tenant HTTP surface does. Serve the two
 * Apis at two paths; never merge them.
 *
 * ### Serving tools to an agent
 * **Example:** A Worker with a tenant API and an MCP server for it
 * ```typescript
 * import { McpProtocol, McpServer } from "effect/ai";
 * import * as HttpRouter from "effect/http/HttpRouter";
 * import { BillingMcp } from "@potion.run/paykit/Surfaces";
 * import { BillingLive } from "./Billing.ts";
 *
 * const Mcp = BillingMcp.pipe(
 *   Layer.provide(
 *     McpServer.layerHttp({ name: "billing", version: "1.0.0", path: "/mcp", protocols: [McpProtocol.v2025_11_25] }),
 *   ),
 *   Layer.provide(BillingLive),
 * );
 *
 * export const { handler } = HttpRouter.toWebHandler(Mcp);
 * ```
 *
 * @layer
 */
export const BillingMcp = DomainAi.toMcp(BillingApi);

/** The same, for the ops console's agent: one tool per admin command and read. */
export const BillingAdminMcp = DomainAi.toMcp(BillingAdminApi);

/** The tenant Api's tools, for an in-app agent that runs in the same Worker. */
export const BillingToolkit = DomainAi.toToolkit(BillingApi);

/** The ops Api's tools. */
export const BillingAdminToolkit = DomainAi.toToolkit(BillingAdminApi);

/**
 * `paykit` on the command line, one subcommand per thing the ops Api serves,
 * talking to a deployed Api over its HTTP protocol. Reads the deployment URL
 * from `PAYKIT_URL` and the session from `PAYKIT_ACTOR` / `PAYKIT_KIND`.
 *
 * ### Running an operator command
 * **Example:** Grant credit from a terminal
 * ```sh
 * PAYKIT_URL=https://billing.example.com/api \
 * PAYKIT_ACTOR=ops_1 PAYKIT_KIND=admin \
 *   paykit grant-credits acct_123 --amount 250
 * ```
 */
export const BillingCli = DomainCli.toCli(BillingAdminApi, {
  name: "paykit",
  description: "Operate a paykit deployment.",
});
