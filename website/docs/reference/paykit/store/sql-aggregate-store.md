---
title: "SqlAggregateStore"
description: "A Domain.AggregateStore over SqlEventLog."
---

> **Source:** [`packages/paykit/src/Store/SqlAggregateStore.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Store/SqlAggregateStore.ts#L55)
> **Kind:** Primitive

A `Domain.AggregateStore` over `SqlEventLog`.

The log is the truth; this adapter is what keeps it that way. Each of the
five guarantees has exactly one place in this file:

1. **One writer per account** — a commit runs in one transaction, so two
   commands on one instance serialize at the write. A decision taken outside
   that transaction carries the version it was made on: if the log moved, the
   append refuses it and the command is decided again, rather than published
   over a state it never saw.
2. **Dedupe by `commandId`** — a replay finds the stored receipt and returns
   it without deciding again, and `append` refuses a second write of the same
   id, so a retried webhook cannot become a second charge.
3. **Atomic commits** — events, state, receipt and deliveries land in one
   transaction: a crash leaves all of a command or none of it.
4. **At-least-once delivery, in order** — deliveries go to the outbox in the
   same transaction and are marked delivered only after their target
   accepted them, so a crash between commit and delivery replays.
5. **`schedule` and `tail`** — a scheduled command is a row with a due time,
   so it survives a restart; a live read polls, which is the correct
   mechanism on a store another process may be committing to.

`decide`, `evolve` and routing stay in the kernel: `kit.handle` produces the
events, state, reply and deliveries, and this store only persists them.

## Hosting a model on SQLite

```typescript
const log = SqlEventLog(sql, { now: () => Date.now() });
const platform = Paykit.SqlPlatform(log);
yield* Bank.layer(BankHandlers).pipe(Effect.provide(platform));
```
