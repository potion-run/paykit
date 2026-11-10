import { Paykit } from "@potion.run/paykit";
import { NodeHttpServer, serve } from "alchemy/Http";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Provider } from "./billing.config.ts";
import { MemoryLive } from "./Billing.layer.ts";

/**
 * Where the process listens. `Config` rather than `process.env`, so the same
 * provider a deployment supplies to the stack decides the port here.
 */
const Port = Config.Port("PORT").pipe(Config.withDefault(3000));

/**
 * The Node HTTP server as a layer, built at the process's scope.
 *
 * `NodeHttpServer` is Alchemy's bridge to `@effect/platform-node`: it provides
 * the `HttpServer` service with no Worker, no fetch handler and no deploy
 * resource. The port value is read once, when the layer is built.
 */
const NodeServer = Layer.unwrap(
  Effect.map(Port, (port) => NodeHttpServer({ port, hostname: "127.0.0.1" })),
);

/**
 * The Node host: `Paykit.handler` mounts the same built-in paths the Worker
 * mounts, and `serve` parks the process until the scope closes.
 *
 * `handler.fetch` reads the ambient request, the same form a Worker returns as
 * `{ fetch: handler.fetch }`. The only host difference is the `HttpServer`
 * implementation underneath it; the model, the guards and the money routes are
 * the same services `examples/billing` provides.
 */
export const program = Effect.gen(function* () {
  const handler = yield* Paykit.handler({
    provider: Provider,
    accountOf: (request) => Paykit.accountFromHeaders(request.headers),
    surfaces: "tenant",
  });

  yield* serve(handler.fetch);
}).pipe(Effect.provide(Layer.merge(MemoryLive, NodeServer)));
