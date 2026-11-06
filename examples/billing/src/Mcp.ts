import type { Services } from "@alchemy.run/domain/Ai";
import { BillingApi } from "@potion.run/paykit";
import { BillingMcp } from "@potion.run/paykit/Surfaces";
import { McpProtocol, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";

/**
 * What the tenant Api's tools need: the hosted model and its middleware. It is
 * the type `DomainAi.toMcp` declares, so the context captured below is exactly
 * what the MCP layer asks for and neither side is widened to make them agree.
 */
type McpServices = Services<typeof BillingApi>;

/**
 * The tenant Api as MCP tools, as one web handler.
 *
 * `BillingMcp` is `DomainAi.toMcp(BillingApi)` — one tool per command and per
 * non-stream read, with no second list to keep in step. Each tool call runs the
 * Api's own `Session` middleware with the MCP request's headers, so an agent
 * reaches exactly what the account it acts for reaches.
 *
 * The environment is captured from the caller rather than passed as a Layer:
 * the Worker has already provided the model and the platform, and the MCP
 * server must serve *those* services, not a second copy of them. Capturing it
 * as `McpServices` is what makes that a type rather than a promise — the
 * returned handler carries the requirement, so a caller that has not provided
 * the world cannot build it.
 */
export const toMcpHandler = Effect.gen(function* () {
  const context = yield* Effect.context<McpServices>();
  const { handler, dispose } = HttpRouter.toWebHandler(
    BillingMcp.pipe(
      Layer.provide(
        McpServer.layerHttp({
          name: "paykit",
          version: "0.1.0",
          path: "/mcp",
          protocols: [McpProtocol.v2025_11_25],
        }),
      ),
      // The services the Worker already provided, handed to the MCP server as
      // the layer it would otherwise build for itself.
      Layer.provide(Layer.succeedContext(context)),
    ),
    { disableLogger: true },
  );
  return { handler, dispose };
});
