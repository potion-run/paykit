import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { ACTOR_HEADER, BillingAdminApi, BillingApi, type WebhookError } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { moneyRoutes, Provider } from "./Billing.ts";
import { BillingDatabase } from "./Database.ts";
import { toMcpHandler } from "./Mcp.ts";
import { billingOnSql } from "./SqlBilling.ts";

/** The account a request acts for. A deployment reads its own session here. */
const accountOf = (request: HttpServerRequest.HttpServerRequest): string | null =>
  request.headers[ACTOR_HEADER] ?? null;

/** The status an error deserves, so a provider learns the right thing and retreats. */
const statusOf = (error: WebhookError | { readonly _tag?: string }): number => {
  switch (error._tag) {
    case "WebhookSignatureInvalid":
      return 401;
    case "WebhookInvalid":
    case "TierNotInCatalog":
      return 400;
    case "ProviderCapabilityMissing":
      return 501;
    default:
      return 500;
  }
};

/**
 * The five paths, served from one model hosted on one database.
 *
 * `/checkout` and `/webhooks/*` are thin on purpose: the account comes from the
 * request, the money moves through `moneyRoutes(provider)`, and the provider's
 * own decoder decides what a delivery means. Swapping `Manual()` for `Polar()`
 * or `Stripe()` in `Billing.ts` is the whole change.
 *
 * Every service this reaches is resolved from the world `serve` provides, so a
 * route cannot answer from a second copy of the model.
 */
const handle = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi;
    const admin = yield* BillingAdminApi;
    const routes = yield* moneyRoutes(Provider);
    // The MCP server is a web handler, not an Effect fetch. `toMcpHandler`
    // captures *these* services — the ones the world provided — so the tools
    // reach the model the routes reach, not a second copy of it.
    const mcp = yield* toMcpHandler;
    yield* Effect.addFinalizer(() => Effect.promise(mcp.dispose));

    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;

    if (path === "/mcp") {
      const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
      return HttpServerResponse.fromWeb(yield* Effect.promise(() => mcp.handler(web)));
    }
    if (path.startsWith("/api")) return yield* tenant.fetch;
    if (path.startsWith("/admin")) return yield* admin.fetch;

    // Ask the provider for a path to pay: `{ url }` on a processor or a
    // merchant of record, `{ invoiceId }` on the manual one, `{ activated }`
    // when the tier is free.
    if (path === "/checkout") {
      const account = accountOf(request);
      if (account === null) {
        return HttpServerResponse.text(`${ACTOR_HEADER} is required`, { status: 401 });
      }
      const tier = url.searchParams.get("tier");
      if (tier === null) {
        return HttpServerResponse.text("?tier= is required", { status: 400 });
      }
      const purchase = yield* Effect.result(routes.purchase(account, tier));
      if (Result.isFailure(purchase)) {
        return HttpServerResponse.jsonUnsafe(
          { error: purchase.failure._tag },
          { status: statusOf(purchase.failure) },
        );
      }
      return HttpServerResponse.jsonUnsafe(purchase.success, { status: 200 });
    }

    // Apply one provider delivery. The decoder verifies the signature and
    // translates the payload; `handleWebhook` owns what it means. A `none`
    // from the decoder is a 202 — acknowledged, nothing to record — which is
    // what stops a provider retrying an event we do not model.
    if (path.startsWith("/webhooks/")) {
      const body = yield* request.text;
      const applied = yield* Effect.result(routes.deliver({ headers: request.headers, body }));
      if (Result.isSuccess(applied)) {
        return HttpServerResponse.jsonUnsafe(applied.success, { status: 202 });
      }
      return HttpServerResponse.jsonUnsafe(
        { error: applied.failure._tag },
        { status: statusOf(applied.failure) },
      );
    }

    return HttpServerResponse.text("Not Found", { status: 404 });
  });

/**
 * The Worker's one handler: resolve the database binding the request carries,
 * build the world on it, and serve. The binding is resolved here and not at
 * construction because a D1 binding only exists inside a request — `raw` is the
 * deferred accessor the platform hands back, and `D1Like` is the Promise-shaped
 * slice of it the store asks for.
 */
const serve = (database: Cloudflare.D1.QueryDatabaseClient) => ({
  fetch: Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const billing = billingOnSql(yield* database.raw);
    const world = Layer.mergeAll(billing.world, Provider.payments);
    return yield* handle(request).pipe(Effect.provide(world));
  }),
});

/**
 * One Worker, five paths, one model, one database:
 *
 * - `/api`      — `BillingApi`, the tenant surface. A signed-in account, scoped to itself.
 * - `/admin`    — `BillingAdminApi`, the ops console. An operator session.
 * - `/mcp`      — the same tenant Api as MCP tools, derived by `DomainAi.toMcp`.
 * - `/checkout` — ask the provider for a path to pay a tier.
 * - `/webhooks` — verify and apply a provider delivery.
 *
 * The model runs on the database declared beside this Worker: the event log,
 * every read model and the entitlement a `check()` answers from live in one
 * schema, and the migration file that creates it is generated from paykit's own
 * DDL, so a test and a release cannot disagree about the tables.
 *
 * The MCP server is the Api, not a second copy of it, so each tool call runs the
 * Api's own `Session` middleware with the MCP request's headers: an agent can
 * only reach what the account it acts for can reach.
 *
 * Without a provider key the example still bills: `Manual` answers `/checkout`
 * with an invoice id, and `/webhooks` reports that the manual provider has no
 * webhook to verify. Point `Billing.ts` at `Polar()` with a fake client in a
 * test — or a real one in a deployment — and the same two routes carry the
 * whole loop.
 */
export default class BillingWorker extends Cloudflare.Worker<BillingWorker>()(
  "BillingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return serve(yield* Cloudflare.D1.QueryDatabase(BillingDatabase));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(DomainCloudflare.layerDurableObjects(), Cloudflare.D1.QueryDatabaseBinding),
    ),
    Effect.orDie,
  ),
) {}
