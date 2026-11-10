---
title: "ArchiveEntity"
description: "Archive an entity and sweep its unspent own sources to the customer in the same command."
---

> **Source:** [`packages/paykit/src/Subscription/ArchiveEntity.command.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/ArchiveEntity.command.ts#L58)
> **Kind:** Binding · **Product:** Entities · **Provides:** `Paykit.Entities`

Archive an entity and sweep its unspent own sources to the customer in the
same command. An archived entity holds nothing and refuses every later write;
a call with no occupancy left to refuse is the only one that succeeds.

The pool is not swept: it belongs to the customer and stays. A close after the
archive does not grant the entity a new plan — its plan sources ended here.

## Closing a scope and returning what it held

```typescript
const balances = yield* Paykit.Balances(account);
yield* balances.update({ entityId: "ent_support", featureId: "seats", usage: 0, idempotencyKey: "seats-0" });

const entities = yield* Paykit.Entities(account);
const archived = yield* entities.archive({ entityId: "ent_support", idempotencyKey: "archive-support-1" });
```
