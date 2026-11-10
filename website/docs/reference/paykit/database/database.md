---
title: "Database"
description: "Exports `DatabaseService`, `Database`."
---

> **Source:** [`packages/paykit/src/Database/Database.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/Database.ts#L35)

## DatabaseService

> **Kind:** Primitive

The database a deployment writes its billing model to.

It is the same seam Alchemy's `BetterAuth.Database` is, for the same reason:
the model never learns which platform answered. `runtime` is the executor a
request uses (memoized on the execution scope, so a pool closes when the
event settles); `migrate` is the deploy's own connection, absent when the
target cannot migrate (Memory) or when another resource owns the schema
(Cloudflare D1 applies its `migrations` directory).

### Providing a target

```ts
import { Sqlite } from "@potion.run/paykit/Database/Sqlite";

const Store = Sqlite({ filename: ":memory:" });

Effect.gen(function* () {
  const database = yield* Paykit.Database;
  const applied = yield* Paykit.sync(yield* database.runtime);
}).pipe(Effect.provide(Store));
```

## Database

> **Kind:** Primitive

The billing database as a service. Provide one layer, read the executor from
it: a Worker, a test and a deploy then share one description of where the
ledger lives.
