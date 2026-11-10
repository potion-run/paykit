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

// The deploy: create the products, prices and meters the catalog states.
const stripe = yield* StripeBilling("Stripe", {
  secretKey: Redacted.make(process.env.STRIPE_API_KEY ?? ""),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
  webhookSecret: Redacted.make(process.env.STRIPE_WEBHOOK_SECRET ?? ""),
});

yield* Paykit.BillingStack("Billing", {
  catalog: { features: [messages], tiers: [free, pro] },
  providers: [stripe],
});

// The runtime: resolve the lookup keys the deploy created.
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

[`examples/stripe`](../../examples/stripe) is the whole loop: the deploy, the
Worker's `GET /checkout?tier=pro`, `POST /webhooks/stripe`, and a test with a fake
client and a signed delivery.

Read the [paykit README](https://www.npmjs.com/package/@potion.run/paykit) and the [billing surface](https://github.com/potion-run/paykit/blob/main/docs/BILLING-SURFACE.md).
