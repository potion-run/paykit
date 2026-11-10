import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { Provider } from "./billing.config.ts";
import { MemoryLive } from "./Billing.layer.ts";

/**
 * The whole deployment: one handler, the tenant Api, the purchase path and the
 * webhook path, on `MemoryStore`.
 *
 * `Paykit.handler` mounts the built-ins and builds no world, so the only thing
 * this file decides is the identity mapping — the development header here, a
 * session in `examples/auth` — and that the process serves the tenant surface,
 * not the operator one.
 *
 * `/api` is the tenant Api; `/checkout?tier=pro` asks the provider for an
 * invoice (the `Manual` provider has no hosted checkout); `/webhooks/*` answers
 * that the manual provider has no delivery to verify. Start at
 * `examples/billing` for the same model on a database, with an operator
 * console, MCP and a typed account API.
 */
export default class BillingWorker extends Cloudflare.Worker<BillingWorker>()(
  "PaykitMemoryWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const handler = yield* Paykit.handler({
      provider: Provider,
      accountOf: (request) => Paykit.accountFromHeaders(request.headers),
      surfaces: "tenant",
    });

    // `handler.fetch` reads the ambient request, the way `auth.fetch` does: the
    // Worker returns the handler's own effect and owns no path table.
    return { fetch: handler.fetch };
  }).pipe(Effect.provide(MemoryLive), Effect.orDie),
) {}
