---
title: "ScheduleTierChange"
description: "Exports `ScheduleTierChange`, `WithdrawTierChange`."
---

> **Source:** [`packages/paykit/src/Billing/ScheduleTierChange.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/ScheduleTierChange.binding.ts#L109)

## ScheduleTierChange

> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.ScheduleTierChange`

Schedule a tier change for the period boundary. This is the answer to a move
`ChangeTier` refuses — a smaller allowance than the period already used, or a
ceiling it has already passed — and to any move a caller wants to take effect
at the next invoice rather than now. The close applies it before the reset, so
the next period starts on the new tier's allowances.

A second schedule replaces the first; `WithdrawTierChange` takes it back.

### Downgrading at the end of the month

```typescript
const schedule = yield* Paykit.ScheduleTierChange(account);
const { pendingTier } = yield* schedule({ tier: "small", dedupeKey: requestId });
```

## WithdrawTierChange

> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.WithdrawTierChange`

Take a scheduled tier change back. Nothing was charged and nothing moved, so
this is the whole undo; a change that has already been applied belongs to
`ChangeTier`.

### Withdrawing a scheduled change

```typescript
const withdraw = yield* Paykit.WithdrawTierChange(account);
yield* withdraw({ dedupeKey: requestId });
```
