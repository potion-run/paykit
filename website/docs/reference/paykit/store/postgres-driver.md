---
title: "PostgresDriver"
description: "Exports `toPostgresPlaceholders`, `postgresExecutor`, `pgPoolExecutor`."
---

> **Source:** [`packages/paykit/src/Store/PostgresDriver.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Store/PostgresDriver.ts#L7)

## toPostgresPlaceholders

> **Kind:** Primitive

Rewrite paykit's `?` placeholders to Postgres's `$1..$n`.

The store statements are dialect-neutral, so the driver owns the placeholder
shape: `@effect/sql-pg` binds `$n`, while SQLite and D1 bind `?`. Quoted
strings, quoted identifiers and dollar-quoted bodies are left alone.

## postgresExecutor

> **Kind:** Primitive

A `SqlExecutor` over an `@effect/sql-pg` client.

Alchemy's `@alchemy.run/sql/Postgres` builds the client from a connection
string — in a Worker, the string `Cloudflare.Hyperdrive.Connect` yields, so
the pool is memoized per execution and Hyperdrive owns the pooling. This
adapter changes only the shape paykit's stores call (`query`, `write`,
`batch`, `atomic`) and the placeholder dialect; the connection, the pool and
the transaction control are the packages' own.

The synchronous half refuses rather than block: a remote target has no
synchronous surface, and a store reaches Postgres only through
`SqlAsyncExecutor`.

### Hosting the model on Postgres

```typescript
const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(Connection);
const client = yield* SQL.Postgres({ url: hyperdrive.connectionString });
const sql = Paykit.postgresExecutor(client);

const log = Paykit.SqlEventLog(sql, { now, schema: "billing" });
const { platform } = Paykit.SqlPlatform(sql, log, { now, schema: "billing" });
const World = Paykit.world({
  catalog,
  platform: Layer.succeed(Domain.Platform, platform),
  readStore: Paykit.SqlBillingReadStore(log),
  guards,
});
```

## pgPoolExecutor

> **Kind:** Primitive

A `SqlExecutor` over a raw `pg` pool.

`atomic` checks out one client for the unit and routes every statement the
unit issues through it, so a read sees the writes before the commit — the
isolation `postgresExecutor` gets from `@effect/sql-pg`'s `withTransaction`,
without that dependency.

### A pool you already hold

```typescript
const sql = Paykit.pgPoolExecutor(pool);
yield* sql.atomic(Effect.gen(function* () {
  yield* sql.write("UPDATE billing_state SET version = ? WHERE account = ?", [2, account]);
}));
```
