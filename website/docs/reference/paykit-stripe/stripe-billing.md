---
title: "StripeBilling"
description: "Stripe provisioning and the Stripe provider in one call."
---

> **Source:** [`packages/paykit-stripe/src/StripeBilling.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/StripeBilling.ts#L25)
> **Kind:** Primitive · **Product:** Stripe

Stripe provisioning and the Stripe provider in one call.

`StripePrices` creates the products, prices, meters and metered prices the
catalog states; `Stripe(props)` turns those keys into the provider the
billing stack validates. A deployment always needs both, and the tier map is
the same in both, so this joins them once instead of making the user repeat
it.

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
```
