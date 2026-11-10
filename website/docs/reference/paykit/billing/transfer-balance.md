---
title: "TransferBalance"
description: "Move balance units between the customer's own scope and one of its entities, or between two entities."
---

> **Source:** [`packages/paykit/src/Billing/TransferBalance.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/TransferBalance.binding.ts#L106)
> **Kind:** Binding · **Product:** Entities · **Provides:** `Paykit.TransferBalance`

Move balance units between the customer's own scope and one of its entities,
or between two entities. One command, one event, one transaction: a crash
cannot debit the source without crediting the target (ADR 0040 §5).

It moves a scope's own sources only. The pool belongs to the customer and is
topped up by an attach, a credit system is one pool per customer, and
occupancy is not a balance — each is a refusal with its own evidence. Plan
units stay plan and lifetime units keep their deadline; a transfer can
shorten a deadline, never extend one.

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
