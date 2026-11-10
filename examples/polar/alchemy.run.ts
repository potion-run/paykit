import * as Cloudflare from "@alchemy.run/cloudflare";
import { Paykit } from "@potion.run/paykit";
import { PolarBilling, polarProviders } from "@potion.run/paykit-polar";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { billingCatalog, polarTiers } from "./src/catalog.ts";

/**
 * The stack: `PolarBilling` creates the products the catalog states and
 * reconciles the webhook endpoint Polar delivers to, then returns the provider
 * `BillingStack` validates, so the tier prices are declared once. The Worker
 * receives the product and meter ids and the endpoint's signing secret from
 * `billing` through its environment; nothing in `src/PolarWorker.ts` names a
 * vendor id, and no one sets `POLAR_WEBHOOK_SECRET` by hand.
 *
 * The token reaches both the resource providers and the runtime. The stack is
 * always pinned to Polar's sandbox, so a production token cannot create
 * production objects from this example.
 *
 * `process.env` at module scope is the one place the Effect rule does not
 * reach: the provider layer is built before the stack's `ConfigProvider`
 * exists, exactly as the live Polar suite reads its token.
 */
const accessToken = Redacted.make(process.env.POLAR_ACCESS_TOKEN ?? "");

const providers = Layer.mergeAll(Cloudflare.providers(), Paykit.providers()).pipe(
  Layer.provideMerge(polarProviders({ accessToken, server: "sandbox" })),
);

const PolarExample = Alchemy.Stack(
  "PaykitPolarExample",
  {
    providers,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const billing = yield* PolarBilling("PolarBilling", {
      accessToken: Redacted.value(accessToken),
      server: "sandbox",
      origin: "https://app.example.com",
      tiers: polarTiers,
    });

    const recorded = yield* Paykit.BillingStack("Billing", {
      catalog: billingCatalog,
      providers: [billing],
    });

    const worker = yield* Cloudflare.Worker("PolarWorker", {
      main: "./src/PolarWorker.ts",
      env: {
        POLAR_ACCESS_TOKEN: accessToken,
        // Minted by the endpoint `PolarBilling` created; the Worker verifies
        // deliveries with this, so the deploy never reads it from the shell.
        POLAR_WEBHOOK_SECRET: billing.webhookEndpoint.secret,
        POLAR_PRODUCT_PRO: billing.sold.products.pro,
        POLAR_MESSAGES_METER: billing.sold.meters.messages,
      },
    });

    return {
      url: worker.url.as<string>(),
      tiers: recorded.tiers,
      products: billing.sold.products,
      meters: billing.sold.meters,
    };
  }).pipe(Effect.orDie),
);

export default PolarExample;
