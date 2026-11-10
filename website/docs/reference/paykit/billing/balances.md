---
title: "Balances"
description: "A customer's balances: the read side of the entitlement plane, one shape for check, track and this."
---

> **Source:** [`packages/paykit/src/Billing/Balances.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Balances.binding.ts#L151)
> **Kind:** Binding · **Product:** Usage · **Provides:** `Paykit.Balances`

A customer's balances: the read side of the entitlement plane, one shape for
`check`, `track` and this. A balance is what a customer can spend of one
feature, with the sources it came from (ADR 0035, ADR 0037).

`list` and `get` never record anything. `update` writes occupancy for a
non-consumable feature; it never bills and never moves the purchase. `finalize`
closes a lock `check({ lock: true })` placed: `commit` bills what ran,
`release` returns all of it.

Every verb takes an optional `entityId`. Absent is the customer's own scope,
so the old call shape is unchanged; present reads or writes that child scope
only. An entity's balance appends the customer's one pooled row, and an
archived scope refuses a write with `EntityArchived` (ADR 0040 §4, §7).

## Reading, then occupying

```typescript
const balances = yield* Paykit.Balances(account);
const seats = yield* balances.get({ featureId: "seats" });
if (seats.remaining !== null && seats.remaining < members.length) {
  yield* balances.update({ featureId: "seats", usage: members.length });
}
```
