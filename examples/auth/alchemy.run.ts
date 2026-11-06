import * as Cloudflare from "@alchemy.run/cloudflare";
import { BillingStackResource, Paykit, providerDescriptor } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { authCatalog } from "./src/catalog.ts";
import AuthWorker from "./src/Worker.ts";

/**
 * The auth-gated billing example: a Better Auth Worker over a D1 auth database,
 * a recorded paykit stack, and the same billing model the other examples serve.
 *
 * `Paykit.Stack` validates the catalog at deploy. The Worker's `/api` and
 * `/admin` routes are guarded by the Better Auth session; the catalog and the
 * model do not know what Better Auth is.
 */
const Example: Alchemy.ConfiguredStack<any, any> = Alchemy.Stack(
  "PaykitAuthExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const billing = yield* Paykit.Stack("Billing", {
      store: Paykit.MemoryStore(),
      providers: [Paykit.Manual()],
      catalog: authCatalog,
    }).pipe(Effect.orDie);

    // The same declarations, recorded in stack state. A catalog that fails to
    // validate dies here rather than half-deploying.
    const recorded = yield* BillingStackResource("Billing", {
      catalog: billing.catalog,
      providers: billing.providers.map(providerDescriptor),
      store: billing.store,
    });

    const worker = yield* AuthWorker;
    return {
      url: worker.url.as<string>(),
      tiers: recorded.tiers,
      model: Paykit.Model.modelName,
    };
  }),
);
export default Example;
