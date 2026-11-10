---
title: "ChargeQuantityProration"
description: "Collect the money a quantity change moved."
---

> **Source:** [`packages/paykit/src/Billing/ChargeQuantityProration.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/ChargeQuantityProration.binding.ts#L64)
> **Kind:** Binding · **Product:** Payments · **Provides:** `Paykit.ChargeQuantityProration`

Collect the money a quantity change moved.

`SetQuantity` records the proration and the key that owns it; this is the
step that opens the provider invoice and records it. A positive `due` is
collected, and the account's quantity credits are spent against it first: the
invoice opens for the net, so a reduction from an earlier period settles here
instead of being paid out as cash (ADR 0042). A credit larger than the charge
leaves a remainder for a later one; a credit that covers the charge fully
records the application and opens no invoice.

## Collecting a seat increase

```typescript
const setQuantity = yield* Paykit.SetQuantity(account);
const { proration } = yield* setQuantity({
  feature: "seats",
  quantity: 8,
  dedupeKey: "seats:2026-11-06",
});
if (proration !== undefined && proration.due > 0) {
  yield* (yield* Paykit.ChargeQuantityProration(account))({
    prorationId: "seats:2026-11-06",
  });
}
```
