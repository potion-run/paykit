import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billing } from "./src/billing.config.ts";
import BillingWorker from "./src/BillingWorker.ts";

/**
 * The quickstart as a deployable stack: `Paykit.BillingStack` validates the
 * catalog and records it, and the Worker serves the same declaration.
 *
 * There is no database and no provider key. The model is `Domain.InMemory` and
 * the store is `MemoryStore`, so a deploy is a Worker and a state record; the
 * ledger does not survive a restart. `examples/billing` is the same catalog on
 * D1, and `examples/stripe` is the same loop sold through a vendor.
 */
const MemoryExample = Alchemy.Stack(
  "PaykitMemoryExample",
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
    };
  }),
);

export default MemoryExample;
