# @potion.run/paykit-stripe

[Stripe](https://stripe.com) as a provider for [`@potion.run/paykit`](https://www.npmjs.com/package/@potion.run/paykit).

`StripeBilling` provisions the prices, products and meters a paykit catalog describes, and `Stripe({ ... })` is the runtime provider the Worker uses for checkout, portal, charges, refunds and webhooks. The money plane stays behind the `Payments` port; the model never reads Stripe.

```sh
pnpm add @potion.run/paykit @potion.run/paykit-stripe alchemy effect
```

```ts
import { Paykit } from "@potion.run/paykit";
import { StripeBilling } from "@potion.run/paykit-stripe";
import * as Redacted from "effect/Redacted";

// The deploy: create the products, prices, meters and webhook endpoint the
// catalog states. The resources are declared here, so the stack's provider
// collection is provided to the call that creates them.
const stripe = yield* StripeBilling("Stripe", {
  secretKey: Redacted.make(process.env.STRIPE_API_KEY ?? ""),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
}).pipe(Effect.provide(Stripe.providers()));

yield* Paykit.BillingStack("Billing", {
  catalog: { features: [messages], tiers: [free, pro] },
  providers: [stripe],
});

// The endpoint lives at `${origin}/webhooks/stripe` and receives exactly the
// events `stripeWebhook` decodes. Stripe mints its signing secret at create, so
// it is an output of the deploy, never a value copied from the dashboard:
const worker = yield* Cloudflare.Worker("Worker", {
  main: "./src/Worker.ts",
  env: { STRIPE_WEBHOOK_SECRET: stripe.webhookEndpoint.secret },
});

// The runtime: resolve the lookup keys the deploy created, and verify
deliveries with the secret the endpoint minted.
const runtime = Stripe({
  secretKey: Redacted.make(env.STRIPE_SECRET_KEY),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      lookupKey: env.STRIPE_PRICE_PRO,
      usage: { messages: { unitPrice: messagePrice, lookupKey: env.STRIPE_MESSAGES_PRICE } },
    },
  },
  meters: { messages: env.STRIPE_MESSAGES_METER },
  webhookSecret: Redacted.make(env.STRIPE_WEBHOOK_SECRET),
});
```

A deployment that already owns an endpoint — a shared API, a different host, a secret in a vault —
passes `webhookSecret` instead, and `StripeBilling` creates nothing.

[`examples/stripe`](https://github.com/potion-run/paykit/tree/main/examples/stripe) is the whole loop: the deploy, the
Worker's `GET /checkout?tier=pro`, `POST /webhooks/stripe`, and a test with a fake
client and a signed delivery.

Read the [paykit README](https://www.npmjs.com/package/@potion.run/paykit) and the [billing surface](https://github.com/potion-run/paykit/blob/main/docs/BILLING-SURFACE.md).

## Credits

Parts of this package are adapted from [Alchemy](https://github.com/alchemy-run/alchemy). Thanks to
the Alchemy team.

