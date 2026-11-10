---
title: "Hold"
description: "Hold capacity for work that has not finished: an agent turn, a long job, a request whose cost is known up front."
---

> **Source:** [`packages/paykit/src/Billing/Hold.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Hold.binding.ts#L74)
> **Kind:** Binding · **Product:** Usage · **Provides:** `Paykit.Hold`

Hold capacity for work that has not finished: an agent turn, a long job, a
request whose cost is known up front. A hold has an id, so [SettleHold](/reference/paykit/billing/settle-hold)
bills exactly that hold and [ReleaseHold](/reference/paykit/billing/release-hold) returns it — never whatever
else happens to be open on the feature.

`dedupeKey` is the command id and the default hold id, so a retry holds once
and settles the entity it placed.

## Holding, then settling what ran

```typescript
const hold = yield* Paykit.Hold(account);
const { holdId } = yield* hold({ feature: "ai", amount: 1000, dimension: "gpt-large", dedupeKey: turnId });

const used = yield* runTheTurn();
yield* settleHold({ holdId, amount: used, dedupeKey: `${turnId}:settle` });
```
