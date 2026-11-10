# Drizzle example

The billing model on the Postgres pool a Drizzle instance already opened.

```sh
POSTGRES_URL=postgres://user:pass@host:5432/paykit_test pnpm --filter @potion.run/example-drizzle deploy
POSTGRES_URL=postgres://user:pass@host:5432/paykit_test pnpm --filter @potion.run/example-drizzle test
```

The application opens one `pg` pool and one Drizzle instance:

```ts
const pool = new Pool({ connectionString: url, max: 1 });
const db = drizzle({ client: pool });
```

paykit adopts that pool, not a second connection:

```ts
import { Drizzle } from "@potion.run/paykit/Database/Drizzle";

const recorded = yield* Paykit.BillingStack("Billing", { ...billing, migrate: true }).pipe(
  Effect.provide(Drizzle(db, { schema: "billing" })),
);
```

`Drizzle(db)` reads `db.$client` (the `pg` Pool), wraps it with
`Paykit.pgPoolExecutor`, and gives the same `DatabaseService` every other
target gives. One pool, one transaction boundary, and `atomic` checks out a
client per unit so a read sees the writes before the commit.

## What this is, and what it is not

It is a **connection** adapter. paykit's stores write their own SQL; the
description in `BILLING_SCHEMA` is still the source of the DDL, and Drizzle does
not generate paykit's tables. Letting Drizzle own the schema would make the ORM
the source and convergence a generator for someone else's tables, which
[ADR 0049](../../docs/adr/0049-the-billing-schema-is-a-description-and-the-deploy-converges-it.md)
rejects.

If the application's own migration pipeline already applies paykit's tables
(`Paykit.sync` over the same executor), pass `migrate: false` and the deploy
Action does nothing:

```ts
Drizzle(db, { schema: "billing", migrate: false });
```

## The live case

`test/example.test.ts` is gated on `POSTGRES_URL`. Without it the case is
skipped; with it the case drops and recreates the `billing` schema, applies the
shipped files through the pool Drizzle holds, runs the model and checks the
event log.
