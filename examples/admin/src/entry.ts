import * as Domain from "@alchemy.run/domain";
import { BillingAdminApi } from "@potion.run/paykit";
import { Console } from "@potion.run/paykit-admin";
import {
  AdminChangeTierClient,
  AdminReadsClient,
  AdminRefundClient,
} from "@potion.run/paykit/Admin";
import "@potion.run/paykit-admin/styles.css";
import "./global.css";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";

/**
 * Ask the Worker for the session cookie before the app boots. The cookie is
 * `HttpOnly`, so only the server can write it; from here on the browser sends
 * it on `fetch`, on the console's RPC calls and on the WebSocket handshake, and
 * the resource layers need no per-call headers.
 *
 * A production host replaces this with its own sign-in page. It should not
 * mint a session for anyone who asks.
 */
const session = await fetch(`${location.origin}/session`, {
  method: "POST",
  credentials: "same-origin",
});

if (!session.ok) console.error("Could not start an admin session:", session.status);

/**
 * The Api client over a WebSocket. The cookie authenticates the handshake, so
 * live reads are pushed by the object that owns the key instead of polled.
 */
const Connection = BillingAdminApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/admin`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);

const resources = Layer.mergeAll(
  Connection,
  AdminReadsClient(`${location.origin}/console`),
  AdminChangeTierClient(`${location.origin}/console`),
  AdminRefundClient(`${location.origin}/console`),
).pipe(Layer.provide(FetchHttpClient.layer));

Runtime.run(
  Runtime.makeApplication({
    ...Console,
    resources,
    container: document.getElementById("root"),
    // The overlay is mounted by `@foldkit/vite-plugin` in development. Passing
    // `Message` also lets the DevTools MCP server dispatch a Message at the
    // console, which is how an agent can drive a feed the local server lacks.
    devTools: {
      show: "Development",
      position: "BottomLeft",
      mode: { development: "TimeTravel", production: "Inspect" },
      banner: "Paykit admin",
      Message: Console.Message,
    },
  }),
  {
    flags: Effect.succeed(
      Console.Flags.make({
        session: crypto.randomUUID(),
        actor: { id: "ops_1", kind: "admin" },
        // The in-app Event lab is a development surface. A deployed console
        // neither shows it nor accepts its Messages.
        devTools: import.meta.env.DEV,
      }),
    ),
  },
);
