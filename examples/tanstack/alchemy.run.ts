import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billing } from "./src/billing.config.ts";
import BillingWorker from "./src/BillingWorker.ts";

/**
 * A TanStack Start website and the paykit service behind it.
 *
 * `Cloudflare.Website.Vite` builds the app with its own `vite.config.ts` and
 * deploys the server bundle as the Worker entry. That entry (`src/worker.ts`)
 * sends `/api/billing` and `/bootstrap` to `BillingWorker` over the service
 * binding and hands every other request to TanStack Start — which is why the
 * browser's atom client can use a same-origin URL and only a cookie.
 *
 * `Paykit.BillingStack` validates the catalog and records the declaration in
 * stack state in one call. The Worker and the browser read the same
 * `src/billing.config.ts`, so the deploy, the runtime and the client cannot
 * disagree about the catalog.
 */
const Example = Alchemy.Stack(
  "PaykitTanstackExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", billing).pipe(Effect.orDie);

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
