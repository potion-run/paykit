// Copied 1:1 from Alchemy's SQLite migration suite, with only the paykit
// entrypoint and table names changed (the upstream test calls
// applyAlchemyFormat directly; this calls paykit's `migrate` wrapper). Keep the
// test shape identical so a catalog bump shows up as a diff.
// Source: https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.85/packages/integration-tests/test/SQL/Migrations/Formats.sqlite.test.ts
// Mirrored locally at .agent_sources/github.com/alchemy-run/alchemy/.
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { migrate, migrationFiles } from "../../src/Migrations/index.ts";
import type { SqlExecutor } from "../../src/Store/Sql.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const ALCHEMY_COLUMNS = ["id", "hash", "created_at", "name", "applied_at"];

const columns = (sql: SqlExecutor, table = "billing_schema_version") =>
  sql.all<{ name: string }>(`PRAGMA table_info(${table});`).map((column) => column.name);

const migrationRows = (sql: SqlExecutor, table = "billing_schema_version") =>
  sql.all<{
    hash: string;
    created_at: number | null;
    name: string;
    applied_at: string | null;
  }>(`SELECT hash, created_at, name, applied_at FROM ${table} ORDER BY id;`);

describe("Alchemy migration registry compatibility", () => {
  it.effect("upgrades the legacy Alchemy 3-column table in place without replaying", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();
      // A pre-registry deploy: the invented shape, TEXT id.
      sql.exec(
        "CREATE TABLE billing_schema_version (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
      );
      sql.exec(
        "INSERT INTO billing_schema_version (id, name, applied_at) VALUES ('00001', '0001_init', '2024-01-01 00:00:00');",
      );
      // A real legacy deploy has the tables 0001 created; the history says so.
      sql.exec(migrationFiles()[0]!.sql);

      // 0001 is adopted, not replayed; only the new migrations apply.
      expect(yield* migrate(sql)).toEqual([]);

      expect(columns(sql)).toEqual(ALCHEMY_COLUMNS);
      const rows = migrationRows(sql);
      expect(rows.map((row) => row.name)).toEqual(["0001_init"]);
      // Backfilled from the matching local record, not a placeholder.
      expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
      // The original applied_at survives the rebuild.
      expect(rows[0]!.applied_at).toContain("2024-01-01");
    }),
  );

  it.effect("upgrades the oldest 2-column shape, reading names from the primary column", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();
      sql.exec(
        "CREATE TABLE billing_schema_version (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
      );
      sql.exec(
        "INSERT INTO billing_schema_version (id, applied_at) VALUES ('0001_init', '2024-01-01 00:00:00');",
      );
      sql.exec(migrationFiles()[0]!.sql);

      expect(yield* migrate(sql)).toEqual([]);

      expect(columns(sql)).toEqual(ALCHEMY_COLUMNS);
      expect(migrationRows(sql).map((row) => row.name)).toEqual(["0001_init"]);
    }),
  );

  it.effect("adopts a wrangler-migrated database: history copied, table frozen", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();
      // What `wrangler d1 migrations apply` left behind.
      sql.exec(
        "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
      );
      sql.exec(
        "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_init', '2024-01-01 00:00:00');",
      );
      sql.exec(migrationFiles()[0]!.sql);

      // The registry records the adopted history; it does not replay 0001.
      expect(yield* migrate(sql)).toEqual(["0001_init"]);

      const rows = migrationRows(sql);
      expect(rows.map((row) => row.name)).toEqual(["0001_init"]);
      expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.applied_at).toContain("2024-01-01");

      // The wrangler table is frozen — never written, never dropped.
      const wrangler = sql.all<{ name: string }>("SELECT name FROM d1_migrations ORDER BY id;");
      expect(wrangler.map((row) => row.name)).toEqual(["0001_init"]);
    }),
  );
});
