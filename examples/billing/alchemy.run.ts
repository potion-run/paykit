import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billing } from "./src/billing.config.ts";
import BillingWorker from "./src/Worker.ts";

/**
 * The stack: one deploy-time billing stack and the Worker that serves it.
 *
 * `Paykit.BillingStack` validates the catalog and every provider price mapping
 * and records the result in Alchemy state in one call — a deploy re-runs
 * `reconcile`, a no-op deploy diffs to nothing, and `RemovalPolicy.RETAIN`
 * keeps the catalog and the ledger when the stack is destroyed.
 *
 * `Paykit.providers()` is what makes the resource callable at all: a resource
 * with no provider layer cannot reconcile.
 *
 * The store is `MemoryStore` so the example runs with no database and no
 * provider key. Swap it for
 * `Paykit.Postgres({ url: Config.Redacted("DATABASE_URL") })` and nothing in
 * the model changes.
 */
const BillingExample = Alchemy.Stack(
  "BillingExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", billing).pipe(Effect.orDie);
    const worker = yield* BillingWorker;
    return {
      url: worker.url.as<string>(),
      tiers: recorded.tiers,
      model: Paykit.Model.modelName,
    };
  }),
);
export default BillingExample;
