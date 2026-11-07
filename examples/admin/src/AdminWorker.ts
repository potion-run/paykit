import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { BillingAdminApi, Paykit } from "@potion.run/paykit";
import { AdminConsoleServer } from "@potion.run/paykit/Admin";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { billing } from "./billing.config.ts";
import { CookieGuards, exampleActor, sessionCookies } from "./Session.ts";

/**
 * The admin surfaces, served from one model:
 *
 * - `/session` — mints the development session cookie. A production host
 *   replaces this with its own sign-in and sets the same cookie fields.
 * - `/admin`   — `BillingAdminApi`, the writes and keyed reads.
 * - `/console` — `AdminConsoleServer`, the cross-account reads, the tier change
 *   and the refund. The refund is why this Worker serves the admin binding: it
 *   is the process that holds the provider, and money only moves here.
 *
 * The Foldkit app is a separate Website Worker on the same origin, forwarding
 * these paths over a service binding.
 */
export default class AdminWorker extends Cloudflare.Worker<AdminWorker>()(
  "PaykitAdminWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const admin = yield* BillingAdminApi;
    const console = yield* AdminConsoleServer;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/session") {
          // The browser sends these cookies on the WebSocket handshake too,
          // which is why the console can use pushed live reads instead of
          // polling. Each cookie needs its own `Set-Cookie` header: a combined
          // header leaves the browser with only the first pair.
          return yield* HttpServerResponse.setCookies(
            HttpServerResponse.empty(),
            sessionCookies(exampleActor, { secure: url.protocol === "https:" }),
          ).pipe(Effect.orDie);
        }
        if (url.pathname.startsWith("/console")) return yield* console;
        if (url.pathname.startsWith("/admin")) return yield* admin.fetch;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Paykit.world({
        ...billing,
        guards: CookieGuards,
        bindings: "admin",
        platform: DomainCloudflare.layerDurableObjects(),
      }),
    ),
    Effect.orDie,
  ),
) {}
