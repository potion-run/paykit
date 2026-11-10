---
title: "resolvePolarProductId"
description: "Resolve a tier's product handle to the id Polar's API expects."
---

> **Source:** [`packages/paykit/src/PaymentsPolar.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/PaymentsPolar.ts#L119)
> **Kind:** Primitive · **Product:** Polar

Resolve a tier's product handle to the id Polar's API expects.

A hand-written config already holds the string; `PolarBilling` holds the
`Output` for the product its deploy created. Resolving here, at the provider
boundary, keeps the deploy from needing an id that does not exist yet.

## Resolving a provisioned product

```typescript
const productId = yield* resolvePolarProductId(sold.products.pro);
```
