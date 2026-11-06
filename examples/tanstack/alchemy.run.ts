import * as Cloudflare from "@alchemy.run/cloudflare";
import { BillingStackResource, Paykit, providerDescriptor } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import BillingWorker from "./src/BillingWorker.ts";
import { tanstackCatalog } from "./src/catalog.ts";

/**
 * A TanStack Start website and the paykit service behind it.
 *
 * `Cloudflare.Website.Vite` builds the app with its own `vite.config.ts` and
 * deploys the server bundle as the Worker entry. That entry (`src/worker.ts`)
 * sends `/api/billing` and `/bootstrap` to `BillingWorker` over the service
 * binding and hands every other request to TanStack Start — which is why the
 * browser's atom client can use a same-origin URL and only a cookie.
 *
 * `Paykit.Stack` validates the catalog at deploy; `BillingStackResource`
 * records the same declarations in stack state.
 */
const Example: Alchemy.ConfiguredStack<any, any> = Alchemy.Stack(
  "PaykitTanstackExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const billing = yield* Paykit.Stack("Billing", {
      store: Paykit.MemoryStore(),
      providers: [Paykit.Manual()],
      catalog: tanstackCatalog,
    }).pipe(Effect.orDie);

    const recorded = yield* BillingStackResource("Billing", {
      catalog: billing.catalog,
      providers: billing.providers.map(providerDescriptor),
      store: billing.store,
    });

    const service = yield* BillingWorker;
    const site = yield* Cloudflare.Website.Vite("PaykitWebsite", {
      rootDir: import.meta.dirname,
      main: "src/worker.ts",
      env: { BILLING: service },
      assets: {
        runWorkerFirst: ["/bootstrap", "/api/billing", "/api/billing/*"],
      },
    });

    return {
      url: site.url.as<string>(),
      billing: service.url.as<string>(),
      tiers: recorded.tiers,
    };
  }),
);
export default Example;
