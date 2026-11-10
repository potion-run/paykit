import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stripe from "@alchemy.run/stripe";
import { Paykit } from "@potion.run/paykit";
import { StripeBilling } from "@potion.run/paykit-stripe";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billingCatalog, stripeTiers } from "./src/catalog.ts";

/**
 * The stack: `StripeBilling` creates the products, prices and meters the
 * catalog states and returns the provider `BillingStack` validates, so the
 * tier prices are declared once. The Worker receives the lookup keys and meter
 * name from `billing.sold` through its environment; nothing in
 * `src/StripeWorker.ts` names a vendor id.
 *
 * `STRIPE_API_KEY` reaches both halves: `Stripe.providers()` reconciles the
 * vendor objects with it, and the runtime provider here checks out and verifies
 * deliveries with it. `STRIPE_WEBHOOK_SECRET` is the endpoint's signing secret,
 * so the Worker verifies Stripe's own signature.
 */
const StripeExample = Alchemy.Stack(
  "PaykitStripeExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Paykit.providers()).pipe(
      Layer.provideMerge(Stripe.providers()),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const secretKey = yield* Config.Redacted("STRIPE_API_KEY");
    const webhookSecret = yield* Config.Redacted("STRIPE_WEBHOOK_SECRET");

    // The Stripe resources are declared here, so the stack's provider
    // collection is provided to the call that creates them.
    const billing = yield* StripeBilling("StripeBilling", {
      secretKey,
      origin: "https://app.example.com",
      tiers: stripeTiers,
      webhookSecret,
    }).pipe(Effect.provide(Stripe.providers()));

    const recorded = yield* Paykit.BillingStack("Billing", {
      catalog: billingCatalog,
      providers: [billing],
    });

    const worker = yield* Cloudflare.Worker("StripeWorker", {
      main: "./src/StripeWorker.ts",
      env: {
        STRIPE_SECRET_KEY: secretKey,
        STRIPE_WEBHOOK_SECRET: webhookSecret,
        STRIPE_PRICE_PRO: billing.sold.prices.pro,
        STRIPE_MESSAGES_PRICE: billing.sold.usage.pro.messages,
        STRIPE_MESSAGES_METER: billing.sold.meters.messages,
      },
    });

    return {
      url: worker.url.as<string>(),
      tiers: recorded.tiers,
      prices: billing.sold.prices,
      meters: billing.sold.meters,
    };
  }).pipe(Effect.orDie),
);

export default StripeExample;
