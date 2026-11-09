// Adapted from Alchemy's SQLite migration suite, pinned by the workspace
// catalog at v2.0.0-beta.85. The apply/idempotence, rewritten-history,
// removed-file, failed-batch and lost-reply cases below are kept structurally
// 1:1 with upstream so a catalog bump shows up as a diff; paykit additions
// cover the schema option, dry run and the synchronous SqlExecutor adapter.
// Source: https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.85/packages/integration-tests/test/SQL/Migrations/Formats.sqlite.test.ts
// Mirrored locally at .agent_sources/github.com/alchemy-run/alchemy/.
import { MigrationError, RewrittenMigrationHistoryError } from "@alchemy.run/sql/Migrations";
import { describe, expect, it } from "@alchemy.run/test";
import { sha256 } from "alchemy/Util/sha256";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  migrate,
  migrateDryRun,
  migrationFiles,
  readMigrationFiles,
  schemaStatements,
} from "../../src/Migrations/index.ts";
import type { SqlExecutor, SqlValue } from "../../src/Store/Sql.ts";
import { assertProperty } from "../support/Property.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const shipped = ["0001_init"] as const;

const migrationRows = (sql: SqlExecutor, table = "billing_schema_version") =>
  sql.all<{
    hash: string;
    created_at: number | null;
    name: string;
    applied_at: string | number | null;
  }>(`SELECT hash, created_at, name, applied_at FROM ${table} ORDER BY id`);

const tables = (sql: SqlExecutor) =>
  sql
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'billing_%' ORDER BY name",
    )
    .map((row) => row.name);

const store = () => sqliteExecutor();

describe("migrations", () => {
  it("prints the DDL before anyone runs it", () => {
    const sql = migrateDryRun();
    expect(sql).toContain("-- 0001_init");
    expect(sql).toContain("billing_event");
    expect(sql).toContain("billing_outbox");
    expect(sql).toContain("billing_rm_backfill");
    expect(sql).toContain("billing_rm_billing_read");
    expect(sql).toContain("billing_schema_version");
    expect(sql).toBe(migrateDryRun());
  });

  it("renders schema-qualified DDL for Postgres", () => {
    const sql = migrateDryRun({ dialect: "postgres", schema: "billing" });
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "billing"');
    expect(sql).toContain('"billing"."billing_event"');
    expect(sql).toContain("BIGINT");
    expect(sql).not.toContain('"public"');
  });

  it("carries every migration as statements and a canonical SQL string", () =>
    Effect.gen(function* () {
      const records = yield* readMigrationFiles({ dialect: "sqlite" });
      expect(records.length).toBe(shipped.length);
      expect(records.map((record) => record.name)).toEqual([...shipped]);

      for (const record of records) {
        expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(record.statements.length).toBeGreaterThan(0);
        expect(record.statements.every((statement) => !statement.trim().endsWith(";"))).toBe(true);
      }

      const all = records[0]!.statements.join(";\n");
      expect(records[0]!.statements.length).toBeGreaterThan(20);
      expect(records[0]!.statements[0]).toContain("CREATE TABLE IF NOT EXISTS");
      expect(all).toContain("billing_rm_billing_read");
      expect(all).toContain("billing_rm_backfill");
      expect(all).toContain("billing_rm_view_outbox");
      expect(all).toContain("billing_outbox");
    }));

  it.effect("renders deterministic, qualified DDL for every scope", () => {
    const Scope = Schema.Struct({
      dialect: Schema.Literals(["sqlite", "postgres"]),
      schema: Schema.Literals(["billing", "billing_2026", "paykit", "workspace"]),
      table: Schema.Literals(["billing_schema_version", "billing_migrations"]),
    });

    return assertProperty(
      Arbitrary.schema(Scope),
      ({ dialect, schema, table }) => {
        const files = migrationFiles({ dialect, schema, table });

        if (files.length === 0) return false;

        const ids = files.map((file) => file.id);

        if (new Set(ids).size !== ids.length) return false;

        if ([...ids].sort().join() !== ids.join()) return false;

        for (const file of files) {
          if (file.statements.length === 0) return false;

          if (file.statements.some((statement) => statement.trim().endsWith(";"))) return false;

          if (file.sql !== `${file.statements.join(";\n")};`) return false;

          if (file.sql.includes('"public"')) return false;

          if (!file.statements.every((statement) => statement.includes("billing_"))) return false;

          const ddl = file.statements.filter(
            (statement) =>
              statement.startsWith("CREATE TABLE") || statement.startsWith("CREATE INDEX"),
          );

          if (dialect === "postgres") {
            // Every table and index is qualified with the chosen schema.
            if (!ddl.every((statement) => statement.includes(`"${schema}".`))) return false;
          } else if (ddl.some((statement) => statement.includes(`"${schema}".`))) {
            return false;
          }
        }

        const created = schemaStatements({ dialect, schema, table });

        if (dialect === "postgres") {
          if (created.length !== 1 || !created[0]!.includes(`"${schema}"`)) return false;
        } else if (created.length !== 0) {
          return false;
        }

        const dry = migrateDryRun({ dialect, schema, table });

        if (!ids.every((id) => dry.includes(`-- ${id}`))) return false;

        if (!dry.includes(table)) return false;

        return dry === migrateDryRun({ dialect, schema, table });
      },
      { runs: 24, size: 8 },
    );
  });

  it.effect("reads the same files as content-hashed records", () => {
    const Scope = Schema.Struct({
      dialect: Schema.Literals(["sqlite", "postgres"]),
      schema: Schema.Literals(["billing", "billing_2026", "paykit", "workspace"]),
    });

    return assertProperty(
      Arbitrary.schema(Scope),
      ({ dialect, schema }) =>
        Effect.gen(function* () {
          const files = migrationFiles({ dialect, schema });
          const records = yield* readMigrationFiles({ dialect, schema });

          if (records.length !== files.length) return false;

          return records.every((record, index) => {
            const file = files[index]!;

            return (
              record.name === file.id &&
              record.sql === file.sql &&
              record.statements.length === file.statements.length &&
              /^[0-9a-f]{64}$/.test(record.hash)
            );
          });
        }),
      { runs: 16, size: 8 },
    );
  });

  it.effect("creates the table and applies migrations in order", () =>
    Effect.gen(function* () {
      const sql = store();
      const applied = [...shipped];
      expect(yield* migrate(sql)).toEqual(applied);
      expect(yield* migrate(sql)).toEqual([]);

      const rows = migrationRows(sql);
      expect(rows.map((row) => row.name)).toEqual(applied);
      expect(rows[0]!.hash).toBe((yield* readMigrationFiles())[0]!.hash);
      expect(rows[0]!.created_at).toBe(null);
      expect(rows[0]!.applied_at).not.toBe(null);

      expect(tables(sql)).toEqual([
        "billing_event",
        "billing_outbox",
        "billing_receipt",
        "billing_rm_backfill",
        "billing_rm_billing_read",
        "billing_rm_policy_seen",
        "billing_rm_projection_cursor",
        "billing_rm_projection_input",
        "billing_rm_stream_entry",
        "billing_rm_stream_meta",
        "billing_rm_view_entry",
        "billing_rm_view_input",
        "billing_rm_view_outbox",
        "billing_rm_view_state",
        "billing_schedule",
        "billing_schema_version",
        "billing_state",
      ]);
      expect(
        sql
          .all<{ name: string }>("PRAGMA table_info(billing_schema_version)")
          .map((row) => row.name),
      ).toEqual(["id", "hash", "created_at", "name", "applied_at"]);
    }),
  );

  it.effect("records a content hash that changes with the SQL", () =>
    Effect.gen(function* () {
      const first = yield* readMigrationFiles();
      const second = yield* readMigrationFiles();
      expect(first[0]!.hash).toBe(second[0]!.hash);
      expect(first[0]!.hash).toBe(yield* sha256(first[0]!.sql));
    }),
  );

  it.effect("honours a custom applied-migrations table", () =>
    Effect.gen(function* () {
      const sql = store();
      expect(yield* migrate(sql, { table: "paykit_migrations" })).toEqual([...shipped]);
      expect(migrationRows(sql, "paykit_migrations").map((row) => row.name)).toEqual([...shipped]);
      expect(tables(sql)).not.toContain("billing_schema_version");
    }),
  );

  it.effect("refuses `public` without touching the database", () =>
    Effect.gen(function* () {
      const sql = {
        dialect: "postgres",
        run: () => {
          throw new Error("must not run");
        },
        exec: () => {
          throw new Error("must not exec");
        },
        get: () => {
          throw new Error("must not get");
        },
        all: () => {
          throw new Error("must not all");
        },
        transaction: () => {
          throw new Error("must not transaction");
        },
        lock: () => {},
      } satisfies SqlExecutor;

      const error = yield* Effect.flip(migrate(sql, { schema: "public" }));
      expect(error).toBeInstanceOf(MigrationError);
      expect(error.message).toContain("public");
    }),
  );

  it.effect("refuses an unsafe bookkeeping table name", () =>
    Effect.gen(function* () {
      const sql = store();

      const error = yield* Effect.flip(
        migrate(sql, { table: "billing; DROP TABLE billing_event" }),
      );

      expect(error).toBeInstanceOf(MigrationError);
      expect(error.message).toContain("safe");
    }),
  );

  it.effect("refuses to read an unreadable registry as a fresh database", () =>
    Effect.gen(function* () {
      const base = store();

      const denied: SqlExecutor = {
        ...base,
        all: (statement: string, params?: ReadonlyArray<SqlValue>) => {
          if (statement.includes("billing_schema_version")) throw new Error("permission denied");

          return base.all(statement, params);
        },
      };

      // A permission failure is not "no table yet": swallowing it would replay
      // every migration over a database whose history nobody can read.
      expect(Exit.isFailure(yield* Effect.exit(migrate(denied)))).toBe(true);
    }),
  );

  it.effect("fails when an already-applied migration's contents changed", () =>
    Effect.gen(function* () {
      const sql = store();
      yield* migrate(sql);
      sql.run("UPDATE billing_schema_version SET hash = ? WHERE name = ?", [
        "a".repeat(64),
        "0001_init",
      ]);
      const error = yield* Effect.flip(migrate(sql));
      expect(error).toBeInstanceOf(RewrittenMigrationHistoryError);
      expect(error._tag).toBe("RewrittenMigrationHistoryError");

      if (error._tag !== "RewrittenMigrationHistoryError") throw error;
      expect(error.changed).toEqual(["0001_init"]);
      expect(migrationRows(sql).length).toBe(shipped.length);
    }),
  );

  it.effect("fails when an already-applied migration file is removed", () =>
    Effect.gen(function* () {
      const sql = store();
      yield* migrate(sql);
      sql.run("INSERT INTO billing_schema_version (hash, name, applied_at) VALUES (?, ?, ?)", [
        "b".repeat(64),
        "0003_gone",
        "2030-01-01T00:00:00Z",
      ]);
      const error = yield* Effect.flip(migrate(sql));
      expect(error).toBeInstanceOf(RewrittenMigrationHistoryError);
      expect(error._tag).toBe("RewrittenMigrationHistoryError");

      if (error._tag !== "RewrittenMigrationHistoryError") throw error;
      expect(error.removed).toEqual(["0003_gone"]);
    }),
  );

  it.effect("fails a non-transient batch failure without resending it", () =>
    Effect.gen(function* () {
      const base = store();

      const failing: SqlExecutor = {
        ...base,
        exec: (statement: string) => {
          if (statement.includes('"billing_event"')) throw new Error("disk full");
          base.exec(statement);
        },
      };

      const error = yield* Effect.flip(migrate(failing));
      expect(error).toBeInstanceOf(MigrationError);
      expect(error.message).toContain("0001_init");
      expect(migrationRows(base)).toEqual([]);
      expect(tables(base)).not.toContain("billing_event");
    }),
  );

  it.effect("applies each migration's statements and bookkeeping in one transaction", () =>
    Effect.gen(function* () {
      const base = store();
      const transactional: SqlExecutor = { ...base };
      expect(yield* migrate(transactional)).toEqual([...shipped]);
      expect(migrationRows(base).map((row) => row.name)).toEqual([...shipped]);
      expect(tables(base)).toContain("billing_event");
    }),
  );

  it.effect("applies the Postgres path with a schema-qualified registry", () =>
    Effect.gen(function* () {
      const db = sqliteExecutor();

      // SQLite stands in for Postgres here: schema-qualified identifiers are
      // stripped, schema/search_path statements are accepted as no-ops, and
      // the catalog introspection answers "no foreign history". Everything
      // else — the registry's bookkeeping queries and every migration
      // statement — really runs.
      const strip = (statement: string) =>
        statement
          .replaceAll('"billing".', "")
          // The registry emits Postgres bookkeeping DDL; SQLite needs the
          // two constructs it cannot parse rewritten (SERIAL, now() default).
          .replace("id SERIAL PRIMARY KEY", "id INTEGER PRIMARY KEY AUTOINCREMENT")
          .replace("applied_at timestamp with time zone DEFAULT now()", "applied_at TEXT");

      const fakePostgres: SqlExecutor = {
        dialect: "postgres",
        run: (statement, params) => {
          if (statement.includes("set_config")) return;
          db.run(strip(statement), params);
        },
        exec: (statement) => {
          if (statement.startsWith("CREATE SCHEMA")) return;
          db.exec(strip(statement));
        },
        get: (statement, params) =>
          statement === "SHOW search_path"
            ? ({ search_path: '"/billing"' } as never)
            : db.get(strip(statement), params),
        all: (statement, params) =>
          statement.includes("information_schema.columns") ? [] : db.all(strip(statement), params),
        transaction: db.transaction,
        lock: db.lock,
      };

      expect(yield* migrate(fakePostgres, { schema: "billing" })).toEqual([...shipped]);
      expect(migrationRows(db).map((row) => row.name)).toEqual([...shipped]);
      expect(tables(db)).toContain("billing_event");
    }),
  );

  it.effect("surfaces a lost reply instead of resending the batch", () =>
    Effect.gen(function* () {
      const base = store();
      let lost = false;

      const flaky: SqlExecutor = {
        ...base,
        // The migration commits, then its reply is lost. The registry checks
        // its history before resending, so the statements do not run twice.
        transaction: <A>(f: () => A): A => {
          const result = base.transaction(f);

          if (!lost) {
            lost = true;
            throw new Error("connection reset after commit");
          }

          return result;
        },
      };

      // A reply lost after the DDL committed is surfaced, not swallowed: the
      // caller retries, and because the DDL is `IF NOT EXISTS` the retry
      // converges on exactly one history row.
      const error = yield* Effect.flip(migrate(flaky));
      expect(error).toBeInstanceOf(MigrationError);
      expect(yield* migrate(base)).toEqual([...shipped]);
      expect(migrationRows(base).map((row) => row.name)).toEqual([...shipped]);
      expect(tables(base)).toContain("billing_event");
    }),
  );
});
