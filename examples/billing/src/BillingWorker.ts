import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { Paykit } from "@potion.run/paykit";
import { D1 } from "@potion.run/paykit/Database/D1";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Provider } from "./billing.config.ts";
import { BillingDatabase } from "./BillingDatabase.ts";
import { toMcpHandler } from "./BillingMcp.ts";
import { billingOn } from "./SqlBilling.ts";

/**
 * The five paths, served from one model hosted on one database.
 *
 * Four of them are `Paykit.handler`: the tenant Api, the console, `/checkout`
 * and `/webhooks/*`. The fifth is `/mcp`, which is this example's own — it is a
 * web handler rather than an Effect fetch, so it arrives as a route the handler
 * tries before the built-ins (ADR 0029).
 *
 * Every service this reaches is resolved from the world `serve` provides, so a
 * route cannot answer from a second copy of the model.
 */
const handle = () =>
  Effect.gen(function* () {
    // The MCP server is a web handler, not an Effect fetch. `toMcpHandler`
    // captures *these* services — the ones the world provided — so the tools
    // reach the model the routes reach, not a second copy of it.
    const mcp = yield* toMcpHandler;
    yield* Effect.addFinalizer(() => Effect.promise(mcp.dispose));

    const handler = yield* Paykit.handler({
      provider: Provider,
      accountOf: (incoming) => Paykit.accountFromHeaders(incoming.headers),
      routes: [
        {
          path: "/mcp",
          handle: (incoming) =>
            Effect.gen(function* () {
              const web = yield* HttpServerRequest.toWeb(incoming).pipe(Effect.orDie);

              return HttpServerResponse.fromWeb(yield* Effect.promise(() => mcp.handler(web)));
            }),
        },
      ],
    });

    return yield* handler.fetch;
  });

/**
 * The Worker's one handler: resolve the database binding the request carries,
 * build the world on it, and serve. The binding is resolved here and not at
 * construction because a D1 binding only exists inside a request — `raw` is the
 * deferred accessor the platform hands back, and `D1Like` is the Promise-shaped
 * slice of it the store asks for.
 */
const serve = () => ({
  // The port resolves the D1 binding on this execution's scope; the model
  // never touches a driver, and `billingOn` is the same function a test calls
  // with a SQLite executor. Provisioning the port here keeps the Worker shape
  // free of the database requirement.
  fetch: Effect.gen(function* () {
    const database = yield* Paykit.Database;
    const now = yield* Clock.currentTimeMillis;
    const billing = billingOn(yield* database.runtime, { now: () => now });
    // The world already carries the deployment's one provider — the same
    // context a command resolves — so its layer is not merged again here.
    const world = billing.world;

    return yield* handle().pipe(Effect.provide(world), Effect.orDie);
  }).pipe(Effect.provide(Layer.mergeAll(D1(BillingDatabase), Cloudflare.D1.QueryDatabaseBinding))),
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
 * webhook to verify. Point `billing.config.ts` at `Polar()` with a fake client
 * in a test — or a real one in a deployment — and the same two routes carry
 * the whole loop.
 */
export default class BillingWorker extends Cloudflare.Worker<BillingWorker>()(
  "BillingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return serve();
  }).pipe(Effect.provide(DomainCloudflare.layerDurableObjects()), Effect.orDie),
) {}
