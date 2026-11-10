import { Database } from "bun:sqlite";
// Two products, two migrators, one database. Better Auth owns its tables and
// paykit owns the `billing_*` family; neither migrator reads or writes the
// other's. This case proves that on one shared SQLite handle rather than
// asserting it in prose, which is the whole basis for the deployment topology
// in ADR 0049: one database with two disjoint table families is supported, and
// so are two databases.
import { describe, expect, it } from "@alchemy.run/test";
import { d1Executor, type D1Like, type D1Prepared, type SqlValue, sync } from "@potion.run/paykit";
import { RuntimeContext } from "alchemy";
import { getMigrations } from "better-auth/db/migration";
import * as Effect from "effect/Effect";

/**
 * A prepared statement over `bun:sqlite`, carrying the SQL and the binds it
 * holds, so `batch` can replay exactly what the executor prepared.
 */
interface FakeStatement extends D1Prepared {
  readonly sql: string;
  readonly params: ReadonlyArray<SqlValue>;
  bind(...values: ReadonlyArray<SqlValue>): FakeStatement;
}

const isFake = (statement: D1Prepared): statement is FakeStatement => "params" in statement;

const statementOver = (
  database: Database,
  sql: string,
  params: ReadonlyArray<SqlValue>,
): FakeStatement => ({
  sql,
  params,
  all: <T = Record<string, unknown>>() =>
    Promise.resolve({ results: database.query<T, SqlValue[]>(sql).all(...params) }),
  bind: (...values) => statementOver(database, sql, values),
});

/** The D1-shaped slice of a `bun:sqlite` handle, for paykit's executor. */
const d1Over = (database: Database): D1Like => ({
  prepare: (sql: string) => statementOver(database, sql, []),
  batch: async (statements) => {
    database.exec("BEGIN IMMEDIATE");

    try {
      for (const statement of statements) {
        if (!isFake(statement)) throw new Error("a statement this fake did not prepare");
        database.query(statement.sql).run(...statement.params);
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

const tables = (database: Database): ReadonlyArray<string> =>
  database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

/** Better Auth's own migrator, against the shared handle. */
const migrateAuth = (database: Database) =>
  Effect.tryPromise(async () => {
    const migrations = await getMigrations({
      database,
      secret: "test-secret-test-secret-test-secret",
      emailAndPassword: { enabled: true },
      telemetry: { enabled: false },
    });

    await migrations.runMigrations();

    return migrations.toBeCreated.length;
  });

describe("auth and billing in one database", () => {
  it.live("two migrators, two table families, no overlap", () =>
    Effect.gen(function* () {
      const database = new Database(":memory:");

      const authTablesCreated = yield* migrateAuth(database);
      expect(authTablesCreated).toBeGreaterThan(0);

      const afterAuth = tables(database);
      expect(afterAuth).toContain("user");
      expect(afterAuth).toContain("session");
      expect(afterAuth.filter((name) => name.startsWith("billing_"))).toEqual([]);

      const migrated = yield* sync(d1Executor(d1Over(database)), { schema: "billing" });

      expect(migrated.applied).toEqual(["0001_init"]);

      const afterBilling = tables(database);

      // The auth family is untouched by paykit's migration...
      for (const name of ["user", "session", "account", "verification"]) {
        expect(afterBilling).toContain(name);
      }

      // ...and the billing family is the one paykit owns.
      expect(afterBilling).toContain("billing_event");
      expect(afterBilling).toContain("billing_rm_billing_read");

      // Exactly one history, and it names only paykit's file.
      const history = database
        .query<{ name: string }, []>("SELECT name FROM billing_schema_version ORDER BY name")
        .all()
        .map((row) => row.name);

      expect(history).toEqual(["0001_init"]);

      // Both migrators are idempotent over the other's work.
      expect(yield* migrateAuth(database)).toBe(0);
      expect((yield* sync(d1Executor(d1Over(database)), { schema: "billing" })).applied).toEqual(
        [],
      );
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  );
});
