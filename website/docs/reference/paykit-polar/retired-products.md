---
title: "RetiredProducts"
description: "Archive the Polar products a stage still sells that its catalog no longer declares."
---

> **Source:** [`packages/paykit-polar/src/RetiredProducts.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/RetiredProducts.ts#L65)
> **Kind:** Primitive · **Product:** Polar

Archive the Polar products a stage still sells that its catalog no longer
declares.

Every product `PolarPrices` creates is declared with `RemovalPolicy.retain`,
so a tier that leaves the catalog keeps its product — a bill already sent has
to stay reproducible. Retain does not stop the product being bought, though: a
detached Polar product is still purchasable, so a retired tier keeps its
checkout entry point. This is the write that closes that gap, and it never
deletes: `is_archived` keeps the product, the orders that reference it, and
the subscriptions priced by it, and Polar still honors the benefits a live
subscription bought.

What to archive is decided by `retiredProducts`, which is pure and tested
against a fixture. This function only lists, asks, and writes.

## Why not a resource

There is nothing here to own. The products a stack sells are `Polar.Product`
resources; the ones this sweeps are precisely the ones no stack owns any more,
so a resource would have to model "the set of objects nobody owns" — a value
Alchemy cannot diff, which would re-run every deploy and report a changing
answer as drift. The sweep is idempotent by construction instead: it archives
what is sellable and undeclared, and a second run finds nothing.

## Archiving retired products

```typescript
const sold = yield* PolarPrices("Prices", { tiers });
const { archived } = yield* RetiredProducts("Retired", { tiers });
```
