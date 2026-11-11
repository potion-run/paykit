import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import AdminWorker from "./src/AdminWorker.ts";
import { billing } from "./src/billing.config.ts";

/**
 * The admin example: one recorded billing stack, the Worker that serves the
 * admin Api and the console reads, and the Foldkit Website that hosts them on
 * one origin.
 *
 * The model runs on Durable Objects, so the example needs no database, and
 * `Manual` needs no provider key. The console's header pair is the development
 * guard; a real deployment replaces it with its own session and CSRF headers.
 */
const Example = Alchemy.Stack(
  "PaykitAdminExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const recorded = yield* Paykit.BillingStack("Billing", billing).pipe(Effect.orDie);

    const worker = yield* AdminWorker;

    const app = yield* Cloudflare.Website.Foldkit("PaykitAdmin", {
      rootDir: import.meta.dirname,
      main: "src/AppWorker.ts",
      // Pin the console to the port the README and the alchemy dev output
      // name, so a restart cannot swap it with the admin Worker's URL.
      dev: { port: 1337 },
      env: { BILLING: worker },
      assets: {
        runWorkerFirst: ["/session", "/admin", "/admin/*", "/console", "/console/*"],
        // The deployed build derives this from the Foldkit manifest. `alchemy
        // dev` does not, so without it every client route except `/` 404s.
        notFoundHandling: "single-page-application",
      },
    });

    return {
      url: app.url.as<string>(),
      worker: worker.url.as<string>(),
      tiers: recorded.tiers,
    };
  }),
);

export default Example;
