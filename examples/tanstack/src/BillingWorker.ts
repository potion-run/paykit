import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import {
  type ActorValue,
  actorFromHeaders,
  BillingApi,
  DevGuards,
  Paykit,
  Subscription,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Result from "effect/Result";
import { billing } from "./billing.config.ts";

/**
 * The billing service for the TanStack Start app:
 *
 * - `/api/*` — the tenant `BillingApi`. The browser's atom client talks to it
 *   through the Website's `/api/billing` proxy, so the actor header comes from
 *   the demo cookie rather than the page.
 * - `/bootstrap` — the demo's one operation: give a visitor the free tier.
 *   A purchase is a provider path (`Paykit.Subscribe`), not a tenant command,
 *   which is why it lives here and not in the atom client.
 *
 * The model runs on Durable Objects, so a usage fact recorded through the Api
 * is still there on the next request.
 */
export default class BillingWorker extends Cloudflare.Worker<BillingWorker>()(
  "PaykitBillingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const tenant = yield* BillingApi;
    const subscribeOf = yield* Paykit.Subscribe;
    const subscription = yield* Subscription;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://billing");

        if (url.pathname === "/bootstrap") {
          const actor: ActorValue | null = actorFromHeaders(request.headers);
          if (actor === null) {
            return HttpServerResponse.text("No x-paykit-actor header", { status: 401 });
          }
          const state = yield* subscription.state(Subscription.ref(actor.id));
          if (state._tag !== "Subscribed") {
            const subscribe = yield* subscribeOf(actor.id);
            const started = yield* Effect.result(subscribe({ tier: "free" }));
            if (Result.isFailure(started)) {
              return HttpServerResponse.jsonUnsafe(
                { error: started.failure._tag },
                { status: Paykit.httpStatus(started.failure) },
              );
            }
          }
          return HttpServerResponse.jsonUnsafe({ account: actor.id });
        }

        // The Api's protocol is rooted at whatever path the client uses as its
        // base; the Website's proxy forwards `/api/billing/*` here unchanged.
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          return yield* tenant.fetch;
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Paykit.world({
        ...billing,
        guards: DevGuards,
        platform: DomainCloudflare.layerDurableObjects(),
      }),
    ),
    Effect.orDie,
  ),
) {}
