import * as Cloudflare from "@alchemy.run/cloudflare";
import { BillingStackResource, Paykit, providerDescriptor } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import AdminWorker from "./src/AdminWorker.ts";
import { adminCatalog } from "./src/catalog.ts";

/**
 * The admin example: one recorded billing stack, the Worker that serves the
 * admin Api and the console reads, and the Foldkit Website that hosts them on
 * one origin.
 *
 * The store is `MemoryStore`, so the example runs with no database and no
 * provider key. The console's header pair is the development guard; a real
 * deployment replaces it with its own session and CSRF headers.
 */
export default Alchemy.Stack(
  "PaykitAdminExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const billing = yield* Paykit.Stack("Billing", {
      store: Paykit.MemoryStore(),
      providers: [Paykit.Manual()],
      catalog: adminCatalog,
    }).pipe(Effect.orDie);

    const recorded = yield* BillingStackResource("Billing", {
      catalog: billing.catalog,
      providers: billing.providers.map(providerDescriptor),
      store: billing.store,
    });

    const worker = yield* AdminWorker;
    const app = yield* Cloudflare.Website.Foldkit("PaykitAdmin", {
      rootDir: import.meta.dirname,
      main: "src/AppWorker.ts",
      env: { BILLING: worker },
      assets: {
        runWorkerFirst: ["/admin", "/admin/*", "/console", "/console/*"],
      },
    });

    return {
      url: app.url.as<string>(),
      worker: worker.url.as<string>(),
      tiers: recorded.tiers,
    };
  }),
);
