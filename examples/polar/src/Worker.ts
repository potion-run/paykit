import { ACTOR_HEADER, moneyRoutes, Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { providerOf, worldOptions, type PolarEnv } from "./Billing.ts";

/** The account a request acts for. A deployment reads its own session here. */
const accountOf = (request: Request): string | null => request.headers.get(ACTOR_HEADER);

/**
 * One request, two money routes:
 *
 * - `GET /checkout?tier=pro` asks Polar for a checkout and returns its URL.
 * - `POST /webhooks/polar` verifies Polar's signature and applies the event.
 *
 * The product id and meter name came from the deploy's `PolarBilling` output
 * through the Worker environment, so this file never repeats a vendor id.
 */
const handle = (request: Request, env: PolarEnv) => {
  const provider = providerOf(env);

  return Effect.gen(function* () {
    const routes = yield* moneyRoutes(provider);
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        provider: provider.name,
        routes: ["GET /checkout?tier=pro", "POST /webhooks/polar"],
      });
    }

    if (url.pathname === "/checkout") {
      const account = accountOf(request);

      if (account === null) {
        return new Response(`${ACTOR_HEADER} is required`, { status: 401 });
      }

      const tier = url.searchParams.get("tier");

      if (tier === null) {
        return new Response("?tier= is required", { status: 400 });
      }

      const purchase = yield* Effect.result(routes.purchase(account, tier));

      if (Result.isFailure(purchase)) {
        return Response.json(
          { error: purchase.failure._tag },
          { status: Paykit.httpStatus(purchase.failure) },
        );
      }

      return Response.json(purchase.success, { status: 200 });
    }

    if (url.pathname === "/webhooks/polar") {
      const body = yield* Effect.promise(() => request.text());

      const applied = yield* Effect.result(
        routes.deliver({ headers: Object.fromEntries(request.headers), body }),
      );

      if (Result.isFailure(applied)) {
        return Response.json(
          { error: applied.failure._tag },
          { status: Paykit.httpStatus(applied.failure) },
        );
      }

      return Response.json(applied.success, { status: 202 });
    }

    return new Response("Not Found", { status: 404 });
  }).pipe(Effect.provide(Paykit.world(worldOptions(provider))), Effect.orDie);
};

export default {
  fetch(request: Request, env: PolarEnv): Promise<Response> {
    return Effect.runPromise(handle(request, env));
  },
};
