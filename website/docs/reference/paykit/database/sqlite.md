---
title: "Sqlite"
description: "A bun:sqlite billing database — development, tests, and a single-process host."
---

> **Source:** [`packages/paykit/src/Database/Sqlite.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/Sqlite.ts#L21)
> **Kind:** Layer · **Product:** SQLite · **Provides:** `paykit/Database`

A `bun:sqlite` billing database — development, tests, and a single-process
host. The same file is opened for the runtime and for migrations, so
`Paykit.sync` and the model read one database.

Import it from `@potion.run/paykit/Database/Sqlite`, not the barrel: it pulls
`bun:sqlite`, which a Node consumer must not load.

## A durable model in one process

```ts
import { Sqlite } from "@potion.run/paykit/Database/Sqlite";

const SqliteDb = Sqlite({ filename: "billing.db" });

Effect.gen(function* () {
  const database = yield* Paykit.Database;
  yield* Paykit.sync(yield* database.runtime); // or a deploy step
}).pipe(Effect.provide(SqliteDb));
```
