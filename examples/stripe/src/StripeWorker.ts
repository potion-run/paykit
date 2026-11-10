import { Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { providerOf, worldOptions, type StripeEnv } from "./Billing.ts";

/** The account a request acts for. A deployment reads its own session here. */
const accountOf = (request: HttpServerRequest.HttpServerRequest): string | null =>
  Paykit.accountFromHeaders(request.headers);

/**
 * The routes this example says it serves, offered at `/` so a deployed Worker
 * explains itself. It is the one path paykit does not know about.
 */
const home = (provider: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      provider,
      routes: ["GET /checkout?tier=pro", "POST /webhooks/stripe"],
    },
    { status: 200 },
  );

/**
 * One request, two money routes:
 *
 * - `GET /checkout?tier=pro` asks Stripe for a Checkout Session and returns its
 *   URL.
 * - `POST /webhooks/stripe` verifies Stripe's signature and applies the event.
 *
 * Both are `Paykit.handler`'s, not this file's: the checkout path, the
 * delivered event and the status a refusal answers are the same four rules
 * every deployment has (ADR 0029). `surfaces: "none"` because this Worker
 * mounts no Api — it is a checkout and a delivery, and `Paykit.world`'s tenant
 * bindings are what those two routes reach.
 *
 * The lookup keys and meter name came from the deploy's `StripeBilling` output
 * through the Worker environment, so this file never repeats a vendor id.
 */
const handle = (request: Request, env: StripeEnv) => {
  const provider = providerOf(env);
  const incoming = HttpServerRequest.fromWeb(request);

  return Effect.gen(function* () {
    const handler = yield* Paykit.handler({
      provider,
      accountOf,
      surfaces: "none",
      routes: [{ path: "/", handle: () => Effect.succeed(home(provider.name)) }],
    });

    const response = yield* handler.fetch.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, incoming),
    );

    return HttpServerResponse.toWeb(response);
  }).pipe(Effect.provide(Paykit.world(worldOptions(provider))), Effect.orDie);
};

export default {
  fetch(request: Request, env: StripeEnv): Promise<Response> {
    // The request is built from a web `Request`, which allocates a scoped body,
    // so the boundary closes that scope once the response is in hand.
    return Effect.runPromise(Effect.scoped(handle(request, env)));
  },
};
