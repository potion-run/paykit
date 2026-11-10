---
title: "SettleHold"
description: "Turn a hold into usage: bill what ran and return the rest, in the same command."
---

> **Source:** [`packages/paykit/src/Billing/SettleHold.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/SettleHold.binding.ts#L64)
> **Kind:** Binding · **Product:** Usage · **Provides:** `Paykit.SettleHold`

Turn a hold into usage: bill what ran and return the rest, in the same command.

Settling an already settled hold records nothing, so a retry bills once; a
released or expired hold is a typed refusal. The answer is the command's own
reply — the units it billed and the units it returned — so it is the same
number over every transport.

## Settling what a turn used

```typescript
const settleHold = yield* Paykit.SettleHold(account);
yield* settleHold({ holdId, amount: tokensUsed, dedupeKey: `${turnId}:settle` });
// released is the units the hold kept and the turn did not spend
```
