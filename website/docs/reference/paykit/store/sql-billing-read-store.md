---
title: "SqlBillingReadStore"
description: "The projection's port, backed by the same database as the event log: one schema holds the truth and its read models, so a dashboard, the edge read path and doctor all see the same rows without a second store to drift."
---

> **Source:** [`packages/paykit/src/Store/SqlBillingReadStore.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Store/SqlBillingReadStore.ts#L11)
> **Kind:** Layer

The projection's port, backed by the same database as the event log: one
schema holds the truth and its read models, so a dashboard, the edge read
path and `doctor` all see the same rows without a second store to drift.

`list` pushes the filter, the cursor and the limit into SQL, so a page costs
a page rather than the whole projection; `summary` is one `GROUP BY`, so the
console's overview costs its counts rather than its rows.

An infrastructure failure is a defect: the port declares no error channel,
and a read model that cannot be read must not look like an empty result.

## Hosting the read models where the truth lives

```typescript
const log = Paykit.SqlEventLog(sql, { now: () => Date.now() });
const reads = Paykit.SqlBillingReadStore(log);
const world = Paykit.Model.layer(
  Paykit.ModelHandlers.pipe(Layer.provide(reads)),
).pipe(Layer.provideMerge(reads), Layer.provide(platform));
```
