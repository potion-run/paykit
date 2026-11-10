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

// The deploy: create the products, meters and prices the catalog states, and
// the webhook endpoint Polar delivers to. The resources are declared here, so
// the stack's provider collection is provided to the call that creates them.
const polar = yield* PolarBilling("Polar", {
  accessToken: Redacted.make(process.env.POLAR_ACCESS_TOKEN ?? ""),
  server: "sandbox",
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
}).pipe(Effect.provide(polarProviders({ accessToken })));

yield* Paykit.BillingStack("Billing", {
  catalog: { features: [messages], tiers: [free, pro] },
  providers: [polar],
});

// The endpoint lives at `${origin}/webhooks/polar` and receives exactly the
// events `polarWebhook` decodes. Polar mints its signing secret at create and
// never returns it again, so it is an output of the deploy — the endpoint's
// state is the only copy, and nothing is set by hand:
const worker = yield* Cloudflare.Worker("Worker", {
  main: "./src/Worker.ts",
  env: { POLAR_WEBHOOK_SECRET: polar.webhookEndpoint.secret },
});

// The runtime: build the provider from the outputs the Worker received.
const runtime = Polar({
  accessToken: env.POLAR_ACCESS_TOKEN,
  server: "sandbox",
  origin: "https://app.example.com",
  tiers: { pro: { price: proPrice, productId: env.POLAR_PRODUCT_PRO } },
  meters: { messages: env.POLAR_MESSAGES_METER },
  webhookSecret: Redacted.make(env.POLAR_WEBHOOK_SECRET),
});
```

A deployment that already owns an endpoint — a shared API, a different host, a secret in a vault —
passes `webhookSecret` instead, and `PolarBilling` creates nothing.

[`examples/polar`](https://github.com/potion-run/paykit/tree/main/examples/polar) is the whole loop: the deploy, the
Worker's `GET /checkout?tier=pro`, `POST /webhooks/polar`, and a test with a fake
client and a signed delivery.

Read the [paykit README](https://www.npmjs.com/package/@potion.run/paykit) and the [billing surface](https://github.com/potion-run/paykit/blob/main/docs/BILLING-SURFACE.md).
