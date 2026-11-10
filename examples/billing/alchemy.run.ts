import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billing } from "./src/billing.config.ts";
import BillingWorker from "./src/BillingWorker.ts";

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
 * The `store` this records is a deploy-time kind, not the Worker's runtime
 * store: the database is the D1 resource beside it, and `billingOnSql` in
 * `src/SqlBilling.ts` is what the Worker and the SQL test actually read. A
 * deployment that manages a Postgres connection records it here as
 * `Paykit.Postgres({ url: Config.Redacted("DATABASE_URL") })`; the recorded
 * kind is what a later deploy diffs.
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
