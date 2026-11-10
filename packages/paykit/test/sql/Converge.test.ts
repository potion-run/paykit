// Convergence is the additive half of a deploy: the files are the baseline a
// reviewer read, and this closes the gap between that baseline and what the
// target actually has. The cases below are the ones a money table can hit:
// a fresh target, an up-to-date target, a column that arrived without a file,
// and the two columns an additive step must refuse to invent.
import { MigrationError } from "@alchemy.run/sql/Migrations";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { converge, migrate, sync } from "../../src/Migrations/index.ts";
import type { SqlExecutor } from "../../src/Store/Sql.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const columnsOf = (sql: SqlExecutor, table: string): ReadonlyArray<string> =>
  sql.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((row) => row.name);

describe("convergence", () => {
  it.live("creates every table on a target the files never touched", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();

      const first = yield* converge(sql);
      expect(first.created.length).toBeGreaterThan(10);
      expect(first.columns).toEqual([]);
      expect(first.extra).toEqual([]);
      expect(first.indexes).toContain("billing_outbox_pending");
      expect(first.indexes).toContain("billing_outbox_account_pending");
      expect(columnsOf(sql, "billing_event")).toContain("event");

      // Idempotent: a converged target needs no DDL.
      const second = yield* converge(sql);
      expect(second.created).toEqual([]);
      expect(second.columns).toEqual([]);
      expect(second.extra).toEqual([]);
    }),
  );

  it.live("adds the target delta to a target the shipped migration built", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();
      yield* migrate(sql);

      const result = yield* converge(sql);
      expect(result.created).toEqual([]);
      expect(result.columns).toEqual([
        "billing_rm_billing_read.customer",
        "billing_rm_billing_read.usage_limited",
      ]);
      expect(result.extra).toEqual([]);
      expect(result.indexes).toContain("billing_outbox_pending");
      expect(result.indexes).toContain("billing_outbox_account_pending");
      expect(result.indexes).toContain("billing_rm_billing_read_attention");

      expect((yield* converge(sql)).columns).toEqual([]);
    }),
  );

  it.live("adds a nullable column the target lacks", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();

      // The outbox without `delivered_at`: a target that predates the column.
      sql.exec(
        `CREATE TABLE "billing_outbox" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT, ` +
          `"aggregate" TEXT NOT NULL, "account" TEXT NOT NULL, "event_seq" INTEGER NOT NULL, ` +
          `"delivery" TEXT NOT NULL)`,
      );

      const result = yield* converge(sql);
      expect(result.columns).toContain("billing_outbox.delivered_at");
      expect(columnsOf(sql, "billing_outbox")).toContain("delivered_at");

      // A second run sees the column and adds nothing.
      expect((yield* converge(sql)).columns).toEqual([]);
    }),
  );

  it.live("reports a column the description does not name, and never drops it", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();
      yield* migrate(sql);
      sql.exec(`ALTER TABLE "billing_state" ADD COLUMN "legacy_flag" INTEGER`);

      const result = yield* converge(sql);
      expect(result.extra).toContain("billing_state.legacy_flag");
      expect(columnsOf(sql, "billing_state")).toContain("legacy_flag");
    }),
  );

  it.live("refuses a NOT NULL column with no default, naming it", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();

      // `billing_schedule` without `due_at`: millis, NOT NULL, no default.
      sql.exec(
        `CREATE TABLE "billing_schedule" ("aggregate" TEXT NOT NULL, "account" TEXT NOT NULL, ` +
          `"command_id" TEXT NOT NULL, "command" TEXT NOT NULL, "delivered_at" INTEGER)`,
      );

      const error = yield* Effect.flip(converge(sql));
      expect(error).toBeInstanceOf(MigrationError);
      expect(error.message).toContain("billing_schedule.due_at");
      expect(error.message).toContain("NOT NULL without a default");
      // The refusal wrote nothing: a half-converged ledger is worse than a stopped deploy.
      expect(columnsOf(sql, "billing_schedule")).not.toContain("due_at");
    }),
  );

  it.live("refuses a key column", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();

      // A table with the description's columns except the composite key's last.
      sql.exec(
        `CREATE TABLE "billing_receipt" ("aggregate" TEXT NOT NULL, "account" TEXT NOT NULL, ` +
          `"version" INTEGER NOT NULL, "receipt" TEXT NOT NULL)`,
      );

      const error = yield* Effect.flip(converge(sql));
      expect(error).toBeInstanceOf(MigrationError);
      expect(error.message).toContain("billing_receipt.command_id");
    }),
  );

  it.live("sync applies the files and converges in one step", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();

      const first = yield* sync(sql);
      expect(first.applied).toEqual(["0001_init"]);
      expect(first.created).toEqual([]);
      expect(first.columns).toEqual([
        "billing_rm_billing_read.customer",
        "billing_rm_billing_read.usage_limited",
      ]);

      const second = yield* sync(sql);
      expect(second.applied).toEqual([]);
      expect(second.created).toEqual([]);
      expect(second.columns).toEqual([]);
    }),
  );
});
