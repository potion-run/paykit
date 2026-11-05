import * as Domain from "@alchemy.run/domain";
import { Console } from "@potion.run/paykit-admin";
import { AdminChangeTierClient, AdminReadsClient } from "@potion.run/paykit/Admin";
import { BillingAdminApi } from "@potion.run/paykit/BillingAdminApi.api";
import { CommandHeaders } from "@potion.run/paykit/Foldkit";
import "@potion.run/paykit-admin/styles.css";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Runtime } from "foldkit";

/**
 * The development admin. A production deployment replaces the header pair
 * with its own session/CSRF headers, and the server replaces `DevGuards`.
 */
const headers = {
  "x-paykit-actor": "ops_1",
  "x-paykit-kind": "admin",
};

/**
 * The development guard reads headers, and a browser cannot set headers on a
 * WebSocket. Use the HTTP protocol here so commands and live reads both carry
 * the header pair; a production app with a same-origin `HttpOnly` cookie should
 * use `protocolWebSocket` instead and set no headers at all. See the package
 * README, "A production session".
 */
const Connection = BillingAdminApi.layerClient.pipe(
  Layer.provide(Domain.protocolHttp(`${location.origin}/admin`)),
);

const resources = Layer.mergeAll(
  Connection,
  AdminReadsClient(`${location.origin}/console`, { headers }),
  AdminChangeTierClient(`${location.origin}/console`, { headers }),
  Layer.succeed(CommandHeaders, {
    get: () => Effect.succeed(headers),
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

Runtime.run(
  Runtime.makeApplication({
    ...Console,
    resources,
    container: document.getElementById("root"),
  }),
  {
    flags: Effect.succeed(
      Console.Flags.make({
        session: crypto.randomUUID(),
        actor: { id: "ops_1", kind: "admin" },
      }),
    ),
  },
);
