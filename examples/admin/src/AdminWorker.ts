import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { BillingAdminApi, DevGuards } from "@potion.run/paykit";
import {
  AdminChangeTierHandlers,
  AdminConsoleRpcs,
  AdminReadsHandlers,
} from "@potion.run/paykit/Admin";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { BillingLayers } from "./Billing.ts";

/**
 * The admin surfaces, served from one model:
 *
 * - `/admin`   — `BillingAdminApi`, the writes and keyed reads.
 * - `/console` — `AdminConsoleRpcs`, the cross-account reads and the tier change.
 *
 * The Foldkit app is a separate Website Worker on the same origin, forwarding
 * both paths over a service binding.
 */
export default class AdminWorker extends Cloudflare.Worker<AdminWorker>()(
  "PaykitAdminWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const admin = yield* BillingAdminApi;
    const reads = yield* AdminReadsHandlers;
    const changes = yield* AdminChangeTierHandlers;
    const rpc = RpcServer.toHttpEffect(AdminConsoleRpcs).pipe(
      Effect.flatten,
      Effect.provide(
        Layer.mergeAll(
          AdminConsoleRpcs.toLayer({ ...reads, ...changes }),
          RpcSerialization.layerNdjson,
          DevGuards,
        ),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path.startsWith("/console")) return yield* rpc;
        if (path.startsWith("/admin")) return yield* admin.fetch;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(BillingLayers.pipe(Layer.provideMerge(DomainCloudflare.layerDurableObjects()))),
    Effect.orDie,
  ),
) {}
