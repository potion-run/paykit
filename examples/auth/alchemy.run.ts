import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billing } from "./src/billing.config.ts";
import AuthWorker from "./src/Worker.ts";

/**
 * The auth-gated billing example: a Better Auth Worker over a D1 auth database,
 * a recorded paykit stack, and the same billing model the other examples serve.
 *
 * `Paykit.BillingStack` validates the catalog and records it at deploy. The
 * Worker's `/api` and `/admin` routes are guarded by the Better Auth session;
 * the catalog and the model do not know what Better Auth is.
 */
const Example = Alchemy.Stack(
  "PaykitAuthExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", billing).pipe(Effect.orDie);

    const worker = yield* AuthWorker;

    return {
      url: worker.url.as<string>(),
      tiers: recorded.tiers,
      model: Paykit.Model.modelName,
    };
  }),
);

export default Example;
