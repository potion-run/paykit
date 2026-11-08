import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schema from "effect/Schema";
import { Session } from "./Auth/Guards.ts";
import { Catalog, catalog as validateCatalog } from "./Catalog.ts";
import { CatalogService } from "./CatalogService.ts";

/**
 * The catalog the deploy sells, served to a signed-in caller.
 *
 * It exists so a browser joins a tier's terms from the deployment's own
 * catalog instead of a bundled copy. Two copies are a drift hazard: a stale
 * asset would send terms the server's `CatalogGuard` refuses with
 * `CatalogMismatch`, which is a failure nobody looking at the page can explain.
 * Served, what a client joins is by construction the value the model was built
 * with.
 *
 * ### Serving the catalog beside the tenant Api
 * **Example:** One Worker, two routes
 * ```typescript
 * const api = yield* BillingApi;
 * const served = yield* PaykitCatalogServer;
 *
 * fetch: Effect.gen(function* () {
 *   const url = new URL((yield* HttpServerRequest).url, "http://billing");
 *   if (url.pathname.startsWith("/api/billing/catalog")) return yield* served;
 *   return yield* api.fetch;
 * })
 * ```
 *
 * @primitive
 * @product Pricing
 */
export const PaykitCatalogRpcs = RpcGroup.make(
  Rpc.make("Catalog", { success: Catalog }),
).middleware(Session);

/** The handlers a Worker serves; the `Session` middleware supplies the actor. */
export const PaykitCatalogHandlers = Effect.map(CatalogService, (catalog) =>
  PaykitCatalogRpcs.of({
    Catalog: () => Effect.succeed(catalog),
  }),
);

/**
 * Serve the catalog. Follows `Domain.Api`'s serve path: the handlers and the
 * `Session` context are captured once, so a custom guard layer cannot be
 * dropped by forgetting to merge one more layer into the endpoint.
 */
export const PaykitCatalogServer = Effect.gen(function* () {
  const handlers = yield* PaykitCatalogHandlers;
  const middleware = yield* Effect.context<Session>();

  return yield* Effect.succeed(
    RpcServer.toHttpEffect(PaykitCatalogRpcs).pipe(
      Effect.flatten,
      Effect.provide(
        Layer.mergeAll(
          PaykitCatalogRpcs.toLayer(handlers),
          RpcSerialization.layerNdjson,
          Layer.succeedContext(middleware),
        ),
      ),
    ),
  );
});

/** A catalog read that never reached the deploy, or whose reply did not decode. */
export class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()(
  "CatalogUnavailable",
  { message: Schema.String },
) {}

/** What a client needs to reach the served catalog. */
export interface PaykitCatalogClientOptions {
  /** Send the caller's own credentials, when the Api is not behind a same-origin cookie. */
  readonly headers?: Headers.Input;
  /**
   * Rewrite every request the client sends. A deployment that mounts the
   * catalog on the same origin as the Api supplies it, so one base URL serves
   * both; a test points it at an ephemeral port.
   */
  readonly transformClient?: <E, R>(
    client: HttpClient.HttpClient.With<E, R>,
  ) => HttpClient.HttpClient.With<E, R>;
}

/**
 * Read the deploy's catalog once and provide it as `CatalogService`.
 *
 * Provide an `HttpClient` (for a browser, `FetchHttpClient.layer`); a
 * same-origin session cookie authenticates the call. The reply is validated on
 * arrival as well as on the server, so a deploy serving a catalog this build
 * cannot read fails here rather than at the first command that joins a tier.
 *
 * @layer
 */
export const PaykitCatalogClient = (url: string, options: PaykitCatalogClientOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(PaykitCatalogRpcs);

      const catalog = yield* RpcClient.withHeaders(client.Catalog(), options.headers ?? {}).pipe(
        Effect.catchTag("RpcClientError", (error) =>
          Effect.fail(new CatalogUnavailable({ message: error.message })),
        ),
      );

      return Layer.succeed(CatalogService, yield* validateCatalog(catalog));
    }),
  ).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url,
        ...(options.transformClient === undefined
          ? {}
          : { transformClient: options.transformClient }),
      }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
  );

/**
 * Everything building the served catalog can fail with: the transport, the
 * catalog's own validation, and the session the guarded read needs. Derived
 * from the layer rather than written out, so the two cannot drift.
 */
export type PaykitCatalogClientError = Layer.Error<ReturnType<typeof PaykitCatalogClient>>;
