---
title: "Polar"
description: "Polar as a merchant of record, ready for Paykit.BillingStack."
---

> **Source:** [`packages/paykit-polar/src/Polar.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/Polar.ts#L320)
> **Kind:** Primitive

Polar as a merchant of record, ready for `Paykit.BillingStack`.

One call, no bindings to wire: `Polar()` returns the `Provider` the catalog
needs, with the tier → product mapping and the price the catalog states, so
`BillingStack` can refuse a mapping that disagrees at deploy time.

It owns tax, receipts and payments; paykit keeps the entitlement. Polar's
benefits are written as a consequence of a tier change and never read back —
`check()` answers from paykit's own read model.

Polar is the one vendor with no Alchemy package, which is why paykit publishes
this one. It is paykit-shaped on purpose: a general provider would need its
own users and release train to justify the same maintenance.

## Selling a product with Polar

```typescript
const polar = Polar({
  accessToken: yield* Config.redacted("POLAR_ACCESS_TOKEN"),
  origin: "https://app.example.com",
  tiers: { pro: { price: proPrice, productId: "prod_123" } },
});

yield* Paykit.BillingStack("Billing", { providers: [polar], catalog });
```
