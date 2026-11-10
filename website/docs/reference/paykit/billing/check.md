---
title: "Check"
description: "The entitlement plane: one local read, no provider round trip, and the balance the customer has of one feature."
---

> **Source:** [`packages/paykit/src/Billing/Check.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Check.binding.ts#L90)
> **Kind:** Binding · **Product:** Usage · **Provides:** `Paykit.Check`

The entitlement plane: one local read, no provider round trip, and the
balance the customer has of one feature. `Check` never records usage —
`TrackUsage` is the write, and it judges the allowance in the transaction
that records it. Asking before acting is how a caller shows a price, not how
it protects a quota: that protection is `TrackUsage` refusing, or a lock.

## Asking before doing work

```typescript
const check = yield* Paykit.Check(account);
const answer = yield* check({ featureId: "messages", requiredBalance: 1 });
if (!answer.allowed) return showUpgrade(answer.standing, answer.balance.nextResetAt);
```

## Reserving what the work will cost

`{ lock: true, idempotencyKey }` places a hold when the answer is allowed, so
a second caller cannot spend the units. Finalize it with
`Paykit.Balances(account).finalize`.
