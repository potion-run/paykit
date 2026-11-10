---
title: "UpdateEntity"
description: "Rename an entity, or clear its name."
---

> **Source:** [`packages/paykit/src/Subscription/UpdateEntity.command.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/UpdateEntity.command.ts#L20)
> **Kind:** Binding · **Product:** Entities · **Provides:** `Paykit.Entities`

Rename an entity, or clear its name. It moves no balance and no plan: the
scope, its sources and its history are what they were (ADR 0040 §7).

An archived entity refuses the write; renaming is not a way to reopen one.

## Renaming a scope

```typescript
const entities = yield* Paykit.Entities(account);
yield* entities.update({ entityId: "ent_support", name: "Support EU", idempotencyKey: "rename-1" });
```
