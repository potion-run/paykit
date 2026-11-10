---
title: "MySQL"
description: "A MySQL billing database, from any connection source."
---

> **Source:** [`packages/paykit/src/Database/MySQL.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/MySQL.ts#L25)
> **Kind:** Layer · **Product:** MySQL · **Provides:** `paykit/Database` · **Peer dependencies:** `@effect/sql-mysql2`, `mysql2`

A MySQL billing database, from any connection source.

The client is Alchemy's own `SQL.MySQL` — an `@effect/sql-mysql2` pool that is
built once per execution and closed when the event settles — adapted to
paykit's executor by `mysqlExecutor`. MySQL binds `?` natively, so there is
no placeholder rewrite.

MySQL has no schema separate from the connection's database: `DatabaseService.schema`
stays undefined and every table is quoted with backticks. Migration identity
is the digest of the deploy URL, never the URL itself.

Import it from `@potion.run/paykit/Database/MySQL`, not the barrel:
`@effect/sql-mysql2` and `mysql2` are optional peers.

## A MySQL host

```ts
import { MySQL } from "@potion.run/paykit/Database/MySQL";

Effect.gen(function* () {
  yield* Paykit.BillingStack("Billing", { ...billing, migrate: true });
}).pipe(Effect.provide(MySQL(Config.Redacted("MYSQL_URL"), {
  migrate: Config.Redacted("MYSQL_MIGRATION_URL"),
})));
```
