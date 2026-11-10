---
title: "d1Executor"
description: "A SqlExecutor over Cloudflare's D1, implementing the asynchronous half of the port that Alchemy's D1 executor implements (@alchemy.run/cloudflare/D1/ApplyMigrations, makeD1MigrationExecutor): query/get for reads, write/batch for writes, and atomic for a unit."
---

> **Source:** [`packages/paykit/src/Store/D1.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Store/D1.ts#L52)
> **Kind:** Primitive

A `SqlExecutor` over Cloudflare's D1, implementing the asynchronous half of
the port that Alchemy's D1 executor implements
(`@alchemy.run/cloudflare/D1/ApplyMigrations`, `makeD1MigrationExecutor`):
`query`/`get` for reads, `write`/`batch` for writes, and `atomic` for a unit.

D1 has no interactive transaction and no isolation between a read and a
commit, so `atomic` collects the unit's writes and commits them in **one**
`batch` call — the closest thing the platform offers, and what Alchemy's own
driver does for D1. `isolation` says `"deferred"` so a store that needs more
can refuse rather than assume.

The synchronous half refuses with an error naming the constraint rather than
blocking a request thread that cannot block.

## Reaching D1 from a Worker

```typescript
const sql = Paykit.d1Executor(env.BILLING);
yield* sql.atomic(
  Effect.gen(function* () {
    yield* sql.write("INSERT INTO billing_event (…) VALUES (?, ?, …)", [...]);
    yield* sql.write("INSERT INTO billing_state (…) VALUES (?, ?, ?)", [...]);
  }),
);
```
