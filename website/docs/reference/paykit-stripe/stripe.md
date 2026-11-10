---
title: "Stripe"
description: "Stripe as a processor, ready for Paykit.BillingStack."
---

> **Source:** [`packages/paykit-stripe/src/Stripe.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/Stripe.ts#L369)
> **Kind:** Primitive

Stripe as a processor, ready for `Paykit.BillingStack`.

One call, no bindings to wire: `Stripe()` returns the `Provider` the catalog
needs, with the tier → price mapping and the price the catalog states, so
`BillingStack` can refuse a mapping that disagrees at deploy time.

It moves money; paykit keeps the entitlement, and `check()` answers from
paykit's own read model rather than from anything read back out of Stripe.

## Selling a tier with Stripe

```typescript
const stripe = Stripe({
  secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
  origin: "https://app.example.com",
  tiers: { pro: { price: proPrice, priceId: "price_123" } },
});

yield* Paykit.BillingStack("Billing", { providers: [stripe], catalog });
```
