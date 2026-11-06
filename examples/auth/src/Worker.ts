import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { BillingAdminApi, BillingApi, Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { Auth, AuthGuards } from "./Auth.ts";
import { AuthDatabase } from "./AuthDatabase.ts";
import { billingLayers } from "./Billing.ts";
import { Page } from "./Page.ts";

/** The status an authentication or purchase failure deserves. */
const statusOf = (error: { readonly _tag?: string }): number => {
  switch (error._tag) {
    case "TierNotInCatalog":
      return 400;
    case "Unauthenticated":
      return 401;
    case "Forbidden":
      return 403;
    case "PaymentDeclined":
      return 402;
    case "ProviderCapabilityMissing":
      return 501;
    default:
      return 500;
  }
};

/**
 * One Worker, four doors:
 *
 * - `/api/auth/*` — Better Auth's own sign-up, sign-in and session routes.
 * - `/api/*`      — `BillingApi`, the tenant surface, gated by the Better Auth
 *                   session. The account is the signed-in user's id.
 * - `/admin/*`    — `BillingAdminApi`, reachable only when the session's user is
 *                   named in `PAYKIT_ADMIN_EMAILS`.
 * - `/checkout`   — the purchase path, which also derives the account from the
 *                   session rather than from a query parameter.
 *
 * The two paykit surfaces carry different `Session` and `Admin` middleware;
 * this file never decides who may call them. That is the guard layers' job, and
 * the same model serves any identity provider that can answer "who is this?".
 */
export const serve = Effect.gen(function* () {
  const auth = yield* Auth;
  const tenant = yield* BillingApi;
  const admin = yield* BillingAdminApi;
  const subscribeOf = yield* Paykit.Subscribe;

  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;

      // Better Auth owns this path. Do not put it behind paykit's guards: a
      // caller cannot have a session yet.
      if (path === "/api/auth" || path.startsWith("/api/auth/")) return yield* auth.fetch;

      // The Session middleware resolves the cookie and pins an account actor to
      // its own id. The Admin middleware requires an admin actor.
      if (path.startsWith("/api")) return yield* tenant.fetch;
      if (path.startsWith("/admin")) return yield* admin.fetch;

      // A purchase is an operation, not a command on the Api: it asks the
      // provider for a checkout URL or an invoice. The account comes from the
      // session, never from `?account=`.
      if (path === "/checkout") {
        const session = yield* auth.getSession().pipe(Effect.orDie);
        if (session === null) {
          return HttpServerResponse.text("Sign in first", { status: 401 });
        }
        const tier = url.searchParams.get("tier");
        if (tier === null) {
          return HttpServerResponse.text("?tier= is required", { status: 400 });
        }
        const subscribe = yield* subscribeOf(session.user.id);
        const purchase = yield* Effect.result(subscribe({ tier }));
        if (Result.isFailure(purchase)) {
          return HttpServerResponse.jsonUnsafe(
            { error: purchase.failure._tag },
            { status: statusOf(purchase.failure) },
          );
        }
        return HttpServerResponse.jsonUnsafe(purchase.success, { status: 200 });
      }

      if (path === "/") return HttpServerResponse.html(Page);
      return HttpServerResponse.text("Not Found", { status: 404 });
    }),
  };
});

/**
 * The Worker world: the billing model and bindings, the Better Auth instance on
 * D1, and the two paykit guards over that instance.
 *
 * `MemoryStore` keeps the example runnable with no billing database. The auth
 * database is the only D1 database, and Better Auth's schema is migrated at
 * deploy by `@alchemy.run/better-auth`.
 */
const World = Layer.mergeAll(
  billingLayers(DomainCloudflare.layerDurableObjects()),
  AuthGuards,
).pipe(Layer.provideMerge(Auth.layer.pipe(Layer.provide(CloudflareD1(AuthDatabase)))));

export default class AuthWorker extends Cloudflare.Worker<AuthWorker>()(
  "AuthWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const server = yield* serve;
    return { fetch: server.fetch };
  }).pipe(Effect.provide(World), Effect.orDie),
) {}
