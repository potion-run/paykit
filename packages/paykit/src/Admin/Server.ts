import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { Admin } from "../Auth/Guards.ts";
import { AdminChangeTierHandlers, AdminConsoleRpcs } from "./ChangeTier.ts";
import { AdminReadsHandlers } from "./Reads.ts";

/**
 * Build the console's RPC handler for a Worker.
 *
 * This follows `Domain.Api`'s serve path: the handlers and the `Admin`
 * middleware context are captured once, then `RpcServer` runs against that
 * context for every request. A custom `Admin` layer or session service
 * therefore cannot be dropped by forgetting to merge one more layer into the
 * endpoint.
 *
 * The host still provides `BillingReadStore`, `CatalogService`, `Subscription`
 * and `Admin` while building this effect.
 *
 * ### Serving the console beside the admin Api
 * **Example:** One Worker, two admin surfaces
 * ```typescript
 * const admin = yield* BillingAdminApi;
 * const console = yield* AdminConsoleServer;
 *
 * fetch: Effect.gen(function* () {
 *   const path = new URL((yield* HttpServerRequest).url, "http://localhost").pathname;
 *   if (path.startsWith("/console")) return yield* console;
 *   return yield* admin.fetch;
 * })
 * ```
 */
export const AdminConsoleServer = Effect.gen(function* () {
  const reads = yield* AdminReadsHandlers;
  const changes = yield* AdminChangeTierHandlers;
  const middleware = yield* Effect.context<Admin>();

  const http = RpcServer.toHttpEffect(AdminConsoleRpcs).pipe(
    Effect.flatten,
    Effect.provide(
      Layer.mergeAll(
        AdminConsoleRpcs.toLayer({ ...reads, ...changes }),
        RpcSerialization.layerNdjson,
        Layer.succeedContext(middleware),
      ),
    ),
  );
  return yield* Effect.succeed(http);
});
