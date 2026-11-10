# @potion.run/paykit-polar

[Polar](https://polar.sh) as a provider for [`@potion.run/paykit`](https://www.npmjs.com/package/@potion.run/paykit).

`PolarBilling` provisions the products, meters and prices a paykit catalog describes, and `Polar({ ... })` is the runtime provider the Worker uses for checkout, portal, charges and webhooks. The money plane stays behind the `Payments` port; the model never reads Polar.

```sh
pnpm add @potion.run/paykit @potion.run/paykit-polar alchemy effect
```

```ts
import { Paykit } from "@potion.run/paykit";
import { PolarBilling } from "@potion.run/paykit-polar";
import * as Redacted from "effect/Redacted";

// The deploy: create the products, meters and prices the catalog states.
// `polarProviders({ server })` resolves POLAR_API_KEY or the selected profile
// and supplies the Credentials layer this call uses; no token is written here.
const polar = yield* PolarBilling("Polar", {
  server: "sandbox",
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
});

yield* Paykit.BillingStack("Billing", {
  catalog: { features: [messages], tiers: [free, pro] },
  providers: [polar],
});

// The runtime: build the provider from the outputs the Worker received.
const runtime = Polar({
  accessToken: env.POLAR_API_KEY,
  server: "sandbox",
  origin: "https://app.example.com",
  tiers: { pro: { price: proPrice, productId: env.POLAR_PRODUCT_PRO } },
  meters: { messages: env.POLAR_MESSAGES_METER },
  webhookSecret: Redacted.make(env.POLAR_WEBHOOK_SECRET),
});
```

`polar.accessToken` is the token the deploy resolved; `polar.webhookEndpoint.secret`
is the endpoint's secret and `polar.sold` the ids. Bind all three into the
Worker's environment.

[`examples/polar`](../../examples/polar) is the whole loop: the deploy, the
Worker's `GET /checkout?tier=pro`, `POST /webhooks/polar`, and a test with a fake
client and a signed delivery.

Read the [paykit README](https://www.npmjs.com/package/@potion.run/paykit) and the [billing surface](https://github.com/potion-run/paykit/blob/main/docs/BILLING-SURFACE.md).
