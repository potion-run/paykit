import { makePgMigrationExecutor, runMigrations, withPgClient } from "@alchemy.run/sql/Migrations";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Client } from "pg";

/** The registry's bookkeeping table; it lives in the `billing` schema. */
const table = "billing_migrations";

/**
 * Apply the committed migrations through Alchemy's own registry
 * (`@alchemy.run/sql/Migrations`): it owns the bookkeeping table, content-hash
 * drift detection and the transaction around each file.
 *
 * The migration file is generated from `Paykit.migrationFiles`, so the DDL a
 * deploy runs and the DDL a test runs cannot drift:
 *
 * ```sh
 * node packages/paykit/scripts/schema.ts postgres --file=0001_init \
 *   > examples/postgres/migrations/0001_init.sql
 * ```
 *
 * `search_path` scopes the registry's unqualified bookkeeping table to the
 * same schema the billing tables live in; the billing DDL is qualified.
 */
export const migratePostgres = (client: Client, input: { readonly dir: string }) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => client.query('CREATE SCHEMA IF NOT EXISTS "billing"'));
    yield* Effect.promise(() => client.query('SET search_path TO "billing", public'));
    yield* runMigrations({
      input: { dir: input.dir, table },
      stamped: {},
      withExecutor: (apply) => apply(makePgMigrationExecutor(client)),
    });
  });

/**
 * The deploy step. `POSTGRES_URL` is read here, not copied into state; the
 * action connects with `pg`, applies pending migrations, and closes the
 * connection. The Worker reaches the same database through Hyperdrive.
 */
export const MigrateBilling = Alchemy.Action(
  "MigrateBilling",
  Effect.fn("Example.MigrateBilling")(function* (input: { readonly dir: string }) {
    const url = yield* Config.Redacted("POSTGRES_URL");

    yield* withPgClient({ connectionString: Redacted.value(url) }, (client) =>
      migratePostgres(client, input),
    );
  }),
);
