import { ACTOR_HEADER, Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { providerOf, worldOptions, type PolarEnv } from "./Billing.ts";

/** The account a request acts for. A deployment reads its own session here. */
const accountOf = (request: HttpServerRequest.HttpServerRequest): string | null =>
  request.headers[ACTOR_HEADER] ?? null;

/**
 * The routes this example says it serves, offered at `/` so a deployed Worker
 * explains itself. It is the one path paykit does not know about.
 */
const home = (provider: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      provider,
      routes: ["GET /checkout?tier=pro", "POST /webhooks/polar"],
    },
    { status: 200 },
  );

/**
 * One request, two money routes:
 *
 * - `GET /checkout?tier=pro` asks Polar for a checkout and returns its URL.
 * - `POST /webhooks/polar` verifies Polar's signature and applies the event.
 *
 * Both are `Paykit.handler`'s, not this file's: the checkout path, the
 * delivered event and the status a refusal answers are the same four rules
 * every deployment has (ADR 0029). `surfaces: "none"` because this Worker
 * mounts no Api — it is a checkout and a delivery, and `Paykit.world`'s tenant
 * bindings are what those two routes reach.
 *
 * The product id and meter name came from the deploy's `PolarBilling` output
 * through the Worker environment, so this file never repeats a vendor id.
 */
const handle = (request: Request, env: PolarEnv) => {
  const provider = providerOf(env);
  const incoming = HttpServerRequest.fromWeb(request);

  return Effect.gen(function* () {
    const serve = yield* Paykit.handler({
      provider,
      accountOf,
      surfaces: "none",
      routes: [{ path: "/", handle: () => Effect.succeed(home(provider.name)) }],
    });

    const response = yield* serve(incoming).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, incoming),
    );

    return HttpServerResponse.toWeb(response);
  }).pipe(Effect.provide(Paykit.world(worldOptions(provider))), Effect.orDie);
};

export default {
  fetch(request: Request, env: PolarEnv): Promise<Response> {
    // The request is built from a web `Request`, which allocates a scoped body,
    // so the boundary closes that scope once the response is in hand.
    return Effect.runPromise(Effect.scoped(handle(request, env)));
  },
};
