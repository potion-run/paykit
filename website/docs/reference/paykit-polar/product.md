---
title: "Product"
description: "A Polar product that sells one tier at the price the catalog states."
---

> **Source:** [`packages/paykit-polar/src/Product.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/Product.ts#L122)
> **Kind:** Resource · **Product:** Product

A Polar product that sells one tier at the price the catalog states.

Polar embeds prices in the product, so the price is a prop of this resource
and a price change replaces the product. That difference from Stripe stops
here: `PolarPrices` returns the tier → product id map, and
`@potion.run/paykit`'s `PolarTier` keeps its `{ price, productId, usage? }`
shape.

The identity is Polar's own metadata: `metadata.paykit_tier = "<tier>"` plus
a stage-qualified name, `paykit:<stage>:<tier>`. A restored state reconciles
to the same product instead of creating a second one, and a price change is
a new generation of the same identity.

## Declaring a product

```typescript
const sold = yield* PolarPrices("Prices", { tiers: { pro: proPrice } });
// sold.products.pro is an Output that resolves to the Polar product id while
// the stack runs. Give it to the app's runtime, where `Polar({ tiers })` needs it.
```

## Replacing a price

```typescript
// A changed amount creates a second product with the same
// `paykit:<stage>:<tier>` identity. The old product stays in Polar, and a
// state-lost deploy adopts the newest generation rather than creating one.
const sold = yield* PolarPrices("Prices", { tiers: { pro: { ...proPrice, amount: 2400 } } });
```

## Retiring a tier

```typescript
// The resource declares `retain`, and `PolarPrices` still pipes
// `RemovalPolicy.retain` explicitly: the product stays in Polar for the
// invoices that reference it, and only Alchemy's state row goes away.
yield* PolarPrices("Prices", { tiers: {} });
```
