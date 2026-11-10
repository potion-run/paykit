---
title: "AttachEntity"
description: "Create an entity under a customer."
---

> **Source:** [`packages/paykit/src/Subscription/AttachEntity.command.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/AttachEntity.command.ts#L22)
> **Kind:** Binding · **Product:** Entities · **Provides:** `Paykit.Entities`

Create an entity under a customer. The customer is the only writer: this is a
command on the customer's aggregate and `entityId` is command data, not a
second account (ADR 0040 §2).

The id is the command id, so a retry with the same id is a replay rather than
a second create. A predefined id is what every caller supplies: an entity is
named by the deployment, so a restored state reconciles to the same scope.

## Creating a scope, then attaching a plan to it

```typescript
const entities = yield* Paykit.Entities(account);
yield* entities.create({ entityId: Paykit.EntityId.make("ent_support"), name: "Support" });

const attach = yield* Paykit.Attach(account);
yield* attach({ entityId: Paykit.EntityId.make("ent_support"), planId: "team", idempotencyKey: "attach-team-1" });
```
