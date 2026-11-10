---
title: "TransferBalance"
description: "Move units between two scopes of one customer: the customer's own scope and one of its entities, or two entities."
---

> **Source:** [`packages/paykit/src/Subscription/TransferBalance.command.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/TransferBalance.command.ts#L79)
> **Kind:** Binding · **Product:** Entities · **Provides:** `Paykit.TransferBalance`

Move units between two scopes of one customer: the customer's own scope and
one of its entities, or two entities. One command, one transaction, one event,
so a crash cannot debit the source without crediting the target.

It moves balance units, never occupancy (ADR 0036), never a credit system
(ADR 0002) and never the pooled source. It is decided from the two scopes'
sources alone: no clock, provider or catalog read, so `decide` stays pure.

## Moving an allowance between two teams

```typescript
const transfer = yield* Paykit.TransferBalance(account);
const moved = yield* transfer({
  from: { kind: "entity", entityId: Paykit.EntityId.make("ent_a") },
  to: { kind: "entity", entityId: Paykit.EntityId.make("ent_b") },
  featureId: "messages",
  amount: 250,
  idempotencyKey: "transfer-1",
});
moved.from.remaining; // the source scope after the move
moved.to.remaining;   // the target scope after the move
```
