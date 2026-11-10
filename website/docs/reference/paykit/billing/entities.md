---
title: "Entities"
description: "A customer's child scopes: a team, a project, a workspace."
---

> **Source:** [`packages/paykit/src/Billing/Entities.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Entities.binding.ts#L91)
> **Kind:** Binding · **Product:** Entities · **Provides:** `Paykit.Entities`

A customer's child scopes: a team, a project, a workspace. An entity is a
scope under the customer's one aggregate, not a second customer — it has its
own plan set and balance sources, and a read for it is a filtered read of the
customer's view (ADR 0040 §1–3).

`create` is idempotent by `entityId`; `update` records nothing when the name
is unchanged; `archive` is terminal and returns the scope's unspent own
sources to the customer in the same command. Nothing a bill references is
deleted, so `list` keeps archived scopes too.

## One team, its own plan, then its closure

```typescript
const entities = yield* Paykit.Entities(account);
const support = yield* entities.create({
  entityId: Paykit.EntityId.make("ent_support"),
  name: "Support",
});

const attach = yield* Paykit.Attach(account);
yield* attach({ entityId: support.id, planId: "team", idempotencyKey: "attach-team-1" });

const archived = yield* entities.archive({
  entityId: support.id,
  idempotencyKey: "archive-support-1",
});
```
