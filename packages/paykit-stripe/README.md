# @potion.run/paykit-stripe

[Stripe](https://stripe.com) as a provider for [`@potion.run/paykit`](https://www.npmjs.com/package/@potion.run/paykit).

`StripeBilling` provisions the prices, products and meters a paykit catalog describes, and `Stripe({ ... })` is the runtime provider the Worker uses for checkout, portal, charges, refunds and webhooks. The money plane stays behind the `Payments` port; the model never reads Stripe.

```sh
pnpm add @potion.run/paykit @potion.run/paykit-stripe alchemy effect
```

```ts
import { Paykit } from "@potion.run/paykit";
import { StripeBilling } from "@potion.run/paykit-stripe";

const stripe = yield* StripeBilling("Stripe", {
  ...billing,
  apiKey: process.env.STRIPE_API_KEY!,
});
```

Read the [paykit README](https://www.npmjs.com/package/@potion.run/paykit) and the [billing surface](https://github.com/potion-run/paykit/blob/main/docs/BILLING-SURFACE.md).
