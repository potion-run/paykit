# Postgres example

A Cloudflare Worker whose billing database is Postgres, reached through
[Hyperdrive](https://developers.cloudflare.com/hyperdrive/). The database work
is Alchemy's own integration: `Cloudflare.Hyperdrive.Connection` and `Connect`,
`@alchemy.run/sql/Postgres` (an `@effect/sql-pg` client), and
`@alchemy.run/sql/Migrations` for the deploy's schema. paykit contributes
`Paykit.postgresExecutor` and the SQL stores.

```sh
POSTGRES_URL=postgres://user:pass@host:5432/paykit \
pnpm --filter @potion.run/example-postgres deploy
```

`POSTGRES_URL` is read as an Effect during deploy: Hyperdrive is pointed at that
origin, and the `MigrateBilling` action applies the committed migrations over
`pg`. The Worker never sees the URL — it connects through the Hyperdrive
binding.

```sh
pnpm --filter @potion.run/example-postgres dev    # alchemy dev, using the dev origin
```

| File | What it declares |
| --- | --- |
| `src/catalog.ts` | Two plans over one meter. Plain data, no provider ids. |
| `src/billing.config.ts` | The provider, the catalog and the Postgres store record. |
| `src/Hyperdrive.ts` | The Hyperdrive configuration, with a `dev` origin parsed from `POSTGRES_URL`. |
| `src/Migrate.ts` | The `MigrateBilling` action: Alchemy's migration registry over `pg`. |
| `src/SqlBilling.ts` | The model on the SQL log, platform and read store, in the `billing` schema. |
| `src/PostgresWorker.ts` | One Worker: `/api`, `/checkout` and `/webhooks`, with `handler.fetch`. |
| `migrations/0001_init.sql` | The Postgres DDL generated from `Paykit.migrationFiles`. |
| `alchemy.run.ts` | `BillingStack`, the migration action, the Hyperdrive connection and the Worker. |

Regenerate the migration whenever paykit's schema moves:

```sh
node packages/paykit/scripts/schema.ts postgres --file=0001_init \
  > examples/postgres/migrations/0001_init.sql
```

## Tests

The integration case is gated on `POSTGRES_URL`, like the vendor cases: without
it the case is skipped, so CI stays green with no database. Point it at a
**scratch** database — the case drops and recreates the `billing` schema:

```sh
POSTGRES_URL=postgres://user:pass@host:5432/paykit_test \
  pnpm --filter @potion.run/example-postgres test
```

The test builds the same `@effect/sql-pg` client the Worker uses, applies the
generated migration, runs `Paykit.Subscribe` / `TrackUsage` / `Check` against the
SQL world, and reads the `Entitlements` row back out of Postgres.

## Why Hyperdrive

Hyperdrive pools the connections a Worker would otherwise open per request, and
it is the only way a Worker should reach Postgres: the origin sits behind
Hyperdrive's pooling and caching, and the binding supplies a connection string
that is valid inside the invocation. The Worker opens Alchemy's client from that
string and lets `makeExecutionMemo` own its lifetime; there is no long-lived pool
shared across requests, which workerd forbids.
