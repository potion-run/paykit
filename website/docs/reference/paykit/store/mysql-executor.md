---
title: "mysqlExecutor"
description: "A SqlExecutor over an @effect/sql-mysql2 client — the client @alchemy.run/sql/MySQL builds from a connection URL."
---

> **Source:** [`packages/paykit/src/Store/MySQLDriver.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Store/MySQLDriver.ts#L5)
> **Kind:** Primitive

A `SqlExecutor` over an `@effect/sql-mysql2` client — the client
`@alchemy.run/sql/MySQL` builds from a connection URL.

MySQL binds `?` placeholders natively, so the adapter is
`postgresExecutor`'s shape without the rewrite: `query`, `write`, `batch`
and `atomic` come from the client's own transaction control, and the
synchronous half refuses.

## A MySQL client

```typescript
import * as SQL from "@alchemy.run/sql/MySQL";

const client = yield* SQL.MySQL({ url: connectionString });
const log = Paykit.SqlEventLog(Paykit.mysqlExecutor(client), { now });
```
