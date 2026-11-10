---
title: "SetUsage"
description: "Set how much of a non-consumable feature is in use."
---

> **Source:** [`packages/paykit/src/Billing/SetUsage.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/SetUsage.binding.ts#L69)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.SetUsage`

Set how much of a non-consumable feature is in use. A seat is occupied, not
spent: this never bills, never resets at a boundary and never changes the
purchased quantity (ADR 0036).

Occupancy may exceed the purchase. `check()` then answers `allowed: false`
for a new seat while the people already using one keep working.

## Occupying seats

```typescript
const setUsage = yield* Paykit.SetUsage(account);
const { remaining } = yield* setUsage({ featureId: "seats", usage: members.length });
if (remaining < 0) promptToBuySeats(-remaining);
```
