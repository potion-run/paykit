// MySQL is a third dialect: backtick identifiers, `VARCHAR(191)` for the
// columns a key or an index touches (MySQL rejects `TEXT` in a key), and
// `ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT`. The rendering and the
// upsert spellings are the parts a live server is not needed to pin.
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { migrateDryRun, migrationFiles, schemaFingerprint } from "../../src/Migrations/index.ts";
import { insertIgnoring, upsertRow } from "../../src/Store/Upsert.ts";

describe("the MySQL dialect", () => {
  it("quotes identifiers with backticks and never schema-qualifies", () => {
    const [init] = migrationFiles({ dialect: "mysql" });
    const sql = init!.sql;

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `billing_event`");
    expect(sql).not.toContain('"billing".');
    expect(sql).not.toContain("`billing`.");
    expect(sql).toContain("`aggregate`");
  });

  it("renders key columns as VARCHAR(191) and leaves other text as TEXT", () => {
    const [init] = migrationFiles({ dialect: "mysql" });

    const event = init!.statements.find((statement) =>
      statement.startsWith("CREATE TABLE IF NOT EXISTS `billing_event`"),
    );

    // `aggregate`, `account` and `command_id` are the event's primary key and
    // its index; `event` is the payload and stays TEXT.
    expect(event).toContain("`aggregate` VARCHAR(191) NOT NULL");
    expect(event).toContain("`account` VARCHAR(191) NOT NULL");
    expect(event).toContain("`command_id` VARCHAR(191) NOT NULL");
    expect(event).toContain("`event` TEXT NOT NULL");

    const readModel = init!.statements.find((statement) =>
      statement.startsWith("CREATE TABLE IF NOT EXISTS `billing_rm_billing_read`"),
    );

    expect(readModel).toContain("`account` VARCHAR(191) PRIMARY KEY");
    expect(readModel).toContain("`features` TEXT NOT NULL");
    // A column in an index but not in the key is keyed too.
    expect(readModel).toContain("`standing` VARCHAR(191) NOT NULL");
  });

  it("renders the surrogate key as AUTO_INCREMENT", () => {
    const [init] = migrationFiles({ dialect: "mysql" });

    expect(init!.sql).toContain("`seq` BIGINT AUTO_INCREMENT PRIMARY KEY");
    expect(init!.sql).not.toContain("AUTOINCREMENT");
  });

  it("omits IF NOT EXISTS on an index, which MySQL 8 rejects", () => {
    const [init] = migrationFiles({ dialect: "mysql" });

    expect(init!.sql).toContain("CREATE INDEX `billing_event_command`");
    expect(init!.sql).not.toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("indexes the outbox by instance on keyed columns in the first release", () => {
    const [init] = migrationFiles({ dialect: "mysql" });

    const outbox = init!.statements.find((statement) =>
      statement.startsWith("CREATE TABLE IF NOT EXISTS `billing_outbox`"),
    );

    // The one-instance drain filters by aggregate and account, so the index
    // makes both keyed columns and MySQL renders them `VARCHAR(191)`. A `TEXT`
    // column here is exactly what the index statement below is refused for, so
    // both have to come from the first `CREATE TABLE`, not from convergence.
    expect(outbox).toContain("`aggregate` VARCHAR(191) NOT NULL");
    expect(outbox).toContain("`account` VARCHAR(191) NOT NULL");
    expect(init!.sql).toContain(
      "CREATE INDEX `billing_outbox_account_pending` ON `billing_outbox` (`aggregate`, `account`, `delivered_at`, `seq`)",
    );
  });

  it("renders the dry run for MySQL without a schema statement", () => {
    const dry = migrateDryRun({ dialect: "mysql" });

    expect(dry).toContain("-- paykit billing schema (mysql)");
    expect(dry).not.toContain("CREATE SCHEMA");
    expect(dry).toContain("-- 0001_init");
  });

  it("fingerprints differently from the other dialects", () =>
    Effect.gen(function* () {
      const mysql = yield* schemaFingerprint({ dialect: "mysql" });

      const postgresFingerprint = yield* schemaFingerprint({
        dialect: "postgres",
        schema: "billing",
      });

      const sqlite = yield* schemaFingerprint({ dialect: "sqlite" });

      expect(mysql).not.toBe(postgresFingerprint);
      expect(mysql).not.toBe(sqlite);
    }));
});

describe("the MySQL upserts", () => {
  it("spells insert-or-ignore as INSERT IGNORE", () => {
    expect(insertIgnoring("mysql", "`t`", ["a", "b"])).toBe(
      "INSERT IGNORE INTO `t` (a, b) VALUES (?, ?)",
    );
  });

  it("spells the conflict update as ON DUPLICATE KEY UPDATE", () => {
    const sql = upsertRow("mysql", "`t`", ["a", "b", "c"], ["a"]);

    expect(sql).toBe(
      "INSERT INTO `t` (a, b, c) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE b = VALUES(b), c = VALUES(c)",
    );
  });

  it("keeps a reset column, and the other dialects keep excluded", () => {
    expect(upsertRow("mysql", "`t`", ["a", "b"], ["a"], { reset: ["delivered_at"] })).toContain(
      "delivered_at = NULL",
    );

    expect(upsertRow("postgres", '"t"', ["a", "b"], ["a"])).toBe(
      'INSERT INTO "t" (a, b) VALUES (?, ?) ON CONFLICT (a) DO UPDATE SET b = excluded.b',
    );
  });

  it("leaves SQLite on the Postgres conflict form it already used", () => {
    expect(upsertRow("sqlite", '"t"', ["a", "b"], ["a"])).toContain(
      "ON CONFLICT (a) DO UPDATE SET b = excluded.b",
    );
  });
});
