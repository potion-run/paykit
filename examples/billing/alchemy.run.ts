import * as Cloudflare from "@alchemy.run/cloudflare";
import { BillingStackResource, Paykit, providerDescriptor } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billingCatalog } from "./src/catalog.ts";
import BillingWorker from "./src/Worker.ts";

/**
 * The stack: one deploy-time billing stack and the Worker that serves it.
 *
 * `Paykit.Stack` validates the catalog and every provider price mapping before
 * anything is deployed. `BillingStackResource` then *records* the result in
 * Alchemy state — this is the resource, so a deploy re-runs `reconcile`,
 * a no-op deploy diffs to nothing, and `RemovalPolicy.RETAIN` keeps the
 * catalog and the ledger when the stack is destroyed.
 *
 * `Paykit.providers()` is what makes the resource callable at all: a resource
 * with no provider layer cannot reconcile.
 *
 * The store is `MemoryStore` so the example runs with no database and no
 * provider key. Swap it for
 * `Paykit.Postgres({ url: Config.Redacted("DATABASE_URL") })` and nothing in
 * the model changes.
 */
export default Alchemy.Stack(
  "BillingExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const billing = yield* Paykit.Stack("Billing", {
      store: Paykit.MemoryStore(),
      providers: [Paykit.Manual()],
      catalog: billingCatalog,
    }).pipe(Effect.orDie);
    // The same declarations, recorded in stack state. A catalog that fails to
    // validate dies here rather than half-deploying.
    const recorded = yield* BillingStackResource("Billing", {
      catalog: billing.catalog,
      providers: billing.providers.map(providerDescriptor),
      store: billing.store,
    });
    const worker = yield* BillingWorker;
    return {
      url: worker.url.as<string>(),
      tiers: recorded.tiers,
      model: Paykit.Model.modelName,
    };
  }),
);
