---
title: "PolarPrices"
description: "The Polar products a tier is sold through, reconciled from the catalog."
---

> **Source:** [`packages/paykit-polar/src/Prices.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/Prices.ts#L249)
> **Kind:** Primitive · **Product:** Polar

The Polar products a tier is sold through, reconciled from the catalog.

Yielding this inside a stack creates, replaces and retires products:

- **create** when no product carries `paykit:<stage>:<tier>` and
  `metadata.paykit_tier = "<tier>"`;
- **create a meter and a metered price** for every `usage` feature, from the
  same `unitPrice` the catalog states, so the vendor invoice and the local
  ledger use one number;
- **replace** when the amount, currency, interval or a metered unit price
  changes: Polar embeds prices in the product, so the product itself is the
  price, and the new generation gets a new id while the old one stays in
  Polar;
- **sell as a one-time product** when the tier is `kind: "one_off"`: the
  product has no recurring interval, so checkout is a single payment rather
  than a subscription;
- **retire** when a tier leaves the catalog: every product and meter is
  declared with `RemovalPolicy.retain`, so Polar keeps it and only Alchemy's
  state row goes away.

## Selling tiers

```typescript
const sold = yield* PolarPrices("Prices", {
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
});

const polar = Polar({
  accessToken: yield* Config.redacted("POLAR_ACCESS_TOKEN"),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      productId: sold.products.pro,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
  meters: sold.meters,
});
```
