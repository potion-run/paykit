---
title: "SetQuantity"
description: "Set a non-consumable feature's quantity."
---

> **Source:** [`packages/paykit/src/Billing/SetQuantity.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/SetQuantity.binding.ts#L78)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.SetQuantity`

Set a non-consumable feature's quantity. A seat is bought, not spent: the
command sets the total the account holds, prorates the difference for the
rest of the period, and records the pending charge under the request's
`dedupeKey`. `ChargeQuantityProration` collects it.

## Adding seats

```typescript
const setQuantity = yield* Paykit.SetQuantity(account);
const { quantity, proration } = yield* setQuantity({
  feature: "seats",
  quantity: 8,
  dedupeKey: "seats:2026-11-06",
});
```
