---
title: "RetiredPrices"
description: "Turn off the Stripe prices a stage still has active that its catalog no longer declares."
---

> **Source:** [`packages/paykit-stripe/src/RetiredPrices.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/RetiredPrices.ts#L53)
> **Kind:** Primitive · **Product:** Stripe

Turn off the Stripe prices a stage still has active that its catalog no
longer declares.

Every price `StripePrices` creates is declared with `RemovalPolicy.retain`, so
a tier that leaves the catalog keeps its price — a bill already sent has to
stay reproducible. Retain does not stop the price being sold, though: a
detached Stripe price is still `active`, so a retired tier keeps its checkout
entry point. This is the write that closes that gap, and it never deletes:
`active: false` keeps the object, the invoices that reference it, and the
subscription items priced by it.

What to archive is decided by `retiredPrices`, which is pure and tested
against a fixture. This function only lists, asks, and writes.

## Why not a resource

There is nothing here to own. The prices a stack sells are `Stripe.Price`
resources; the ones this sweeps are precisely the ones no stack owns any more,
so a resource would have to model "the set of objects nobody owns" — a value
Alchemy cannot diff, which would re-run every deploy and report a changing
answer as drift. The sweep is idempotent by construction instead: it archives
what is active and undeclared, and a second run finds nothing.

## Archiving retired prices

```typescript
const sold = yield* StripePrices("Prices", { tiers });
const { archived } = yield* RetiredPrices("Retired", { tiers });
```
