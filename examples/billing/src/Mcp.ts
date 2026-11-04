import { BillingMcp } from "@potion.run/paykit/Surfaces";
import { McpProtocol, McpServer } from "effect/ai";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";

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
 * server must serve *those* services, not a second copy of them.
 */
export const toMcpHandler = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
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
      // The Worker already provided these services; `Effect.context` inside
      // it is typed `never`, exactly as it is where Domain captures the same
      // context to serve an Api.
      Layer.provide(Layer.succeedContext(context as unknown as Context.Context<any>)),
    ),
    { disableLogger: true },
  );
  return { handler, dispose };
});
