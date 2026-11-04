import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { migrate, migrateDryRun } from "../../src/Migrations/index.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

describe("migrations", () => {
  it("prints the DDL before anyone runs it", () => {
    const sql = migrateDryRun();
    expect(sql).toContain("billing_schema_version");
    expect(sql).toContain("billing_event");
    expect(sql).toContain("billing_rm_billing_read");
  });

  it.effect("applies each file once and records its version", () =>
    Effect.gen(function* () {
      const sql = sqliteExecutor();
      expect(yield* migrate(sql, () => 1_000)).toEqual(["0001_init"]);
      expect(yield* migrate(sql, () => 2_000)).toEqual([]);
      const row = sql.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM billing_schema_version",
      );
      expect(row?.count).toBe(1);
      const tables = sql.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'billing_%' ORDER BY name",
      );
      expect(tables.map((table) => table.name)).toEqual([
        "billing_event",
        "billing_outbox",
        "billing_receipt",
        "billing_rm_billing_read",
        "billing_schedule",
        "billing_schema_version",
        "billing_state",
      ]);
    }),
  );
});
