import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import { D1 } from "@potion.run/paykit/Database/D1";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billing } from "./src/billing.config.ts";
import { BillingDatabase } from "./src/BillingDatabase.ts";
import SaasWorker from "./src/SaasWorker.ts";

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
 */
const SaasExample = Alchemy.Stack(
  "SaasExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", { ...billing, migrate: true }).pipe(
      Effect.provide(D1(BillingDatabase)),
      Effect.orDie,
    );

    const worker = yield* SaasWorker;

    return {
      url: worker.url.as<string>(),
      tiers: recorded.tiers,
      model: Paykit.Model.modelName,
    };
  }),
);

export default SaasExample;
