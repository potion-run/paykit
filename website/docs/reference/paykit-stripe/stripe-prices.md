---
title: "StripePrices"
description: "The price resources a tier is sold through, reconciled from the catalog."
---

> **Source:** [`packages/paykit-stripe/src/Prices.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/Prices.ts#L326)
> **Kind:** Primitive · **Product:** Stripe

The price resources a tier is sold through, reconciled from the catalog.

Yielding this inside a stack creates, replaces and retires Stripe prices:

- **create** when no price carries the tier's lookup key;
- **create a meter and a metered price** for every `usage` feature, from the
  same `unitPrice` the catalog states, so the vendor invoice and the local
  ledger use one number;
- **replace** when the amount, currency or interval changes: those props are
  create-only, so Alchemy creates a new price and moves the lookup key onto it
  (`transfer_lookup_key`), because Stripe prices are immutable and a live
  subscription must not change what it is charged;
- **sell as a one-time price** when the tier is `kind: "one_off"`: no
  recurring interval is sent, so checkout can use `mode=payment` instead of
  starting a subscription;
- **retire** when a tier leaves the catalog: every resource is declared with
  `RemovalPolicy.retain`, so the price and meter are left in place and only
  Alchemy's state row goes away.

The vendor resources are `@alchemy.run/stripe`'s own, so ownership metadata,
adoption and drift are the vendor package's problem, not a second
implementation's.

## Selling tiers

```typescript
const sold = yield* StripePrices("Prices", {
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
});

const stripe = Stripe({
  secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      lookupKey: sold.prices.pro,
      usage: {
        messages: {
          unitPrice: { amount: 2, currency: "usd" },
          lookupKey: sold.usage.pro.messages,
        },
      },
    },
  },
  meters: sold.meters,
});
```
