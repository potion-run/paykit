---
title: "StripeBilling"
description: "Stripe provisioning and the Stripe provider in one call."
---

> **Source:** [`packages/paykit-stripe/src/StripeBilling.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/StripeBilling.ts#L65)
> **Kind:** Primitive · **Product:** Stripe

Stripe provisioning and the Stripe provider in one call.

`StripePrices` creates the products, prices, meters and metered prices the
catalog states; `Stripe(props)` turns those keys into the provider the
billing stack validates. A deployment always needs both, and the tier map is
the same in both, so this joins them once instead of making the user repeat
it.

When `webhookSecret` is omitted, the deploy also reconciles the
`WebhookEndpoint` at `origin + webhookPath` and carries the secret Stripe
mints at create to the provider as an `Output`. The secret is the one the
Worker verifies with: `webhookEndpoint.secret` is what a deploy installs in
the Worker's environment, and neither side reads it before the endpoint
exists. Supplying `webhookSecret` keeps the endpoint managed by hand, exactly
as before, and creates nothing.

The two primitives stay exported: use `StripePrices` when the provider is
configured elsewhere, and `Stripe` when the lookup keys are written by hand.

## Selling a catalog through Stripe

```typescript
const stripe = yield* StripeBilling("Stripe", {
  secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
});

yield* Paykit.BillingStack("Billing", { catalog, providers: [stripe] });
// The Worker receives `stripe.webhookEndpoint.secret` as an Output, minted by
// the endpoint this call created at https://app.example.com/webhooks/stripe.
```
