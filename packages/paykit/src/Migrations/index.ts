import * as Effect from "effect/Effect";
import type { SqlExecutor } from "../Store/Sql.ts";

/** A forward-only migration. Once applied, a file is never edited. */
export interface SqlFile {
  readonly id: string;
  readonly hash: string;
  readonly sql: string;
}

const INIT = `
CREATE TABLE IF NOT EXISTS billing_event (
  aggregate   TEXT    NOT NULL,
  account     TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  command_id  TEXT    NOT NULL,
  at          INTEGER NOT NULL,
  event       TEXT    NOT NULL,
  PRIMARY KEY (aggregate, account, seq)
);
CREATE INDEX IF NOT EXISTS billing_event_command
  ON billing_event (aggregate, account, command_id);

CREATE TABLE IF NOT EXISTS billing_receipt (
  aggregate   TEXT    NOT NULL,
  account     TEXT    NOT NULL,
  command_id  TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  receipt     TEXT    NOT NULL,
  PRIMARY KEY (aggregate, account, command_id)
);

CREATE TABLE IF NOT EXISTS billing_state (
  aggregate   TEXT    NOT NULL,
  account     TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  state       TEXT    NOT NULL,
  PRIMARY KEY (aggregate, account)
);

CREATE TABLE IF NOT EXISTS billing_outbox (
  seq         INTEGER PRIMARY KEY,
  aggregate   TEXT    NOT NULL,
  account     TEXT    NOT NULL,
  event_seq   INTEGER NOT NULL,
  delivery    TEXT    NOT NULL,
  delivered_at INTEGER
);

CREATE TABLE IF NOT EXISTS billing_schedule (
  aggregate   TEXT    NOT NULL,
  account     TEXT    NOT NULL,
  command_id  TEXT    NOT NULL,
  due_at      INTEGER NOT NULL,
  command     TEXT    NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (aggregate, account, command_id)
);

CREATE TABLE IF NOT EXISTS billing_rm_billing_read (
  account                TEXT    PRIMARY KEY,
  tier                   TEXT    NOT NULL,
  status                 TEXT    NOT NULL,
  standing               TEXT    NOT NULL,
  period_start           INTEGER NOT NULL,
  period_end             INTEGER NOT NULL,
  cancel_at_period_end   INTEGER NOT NULL,
  credits                INTEGER NOT NULL,
  currency               TEXT,
  features               TEXT    NOT NULL
);
`;

/** The migrations paykit ships, additive and forward-only. */
export const migrationFiles: ReadonlyArray<SqlFile> = [
  { id: "0001_init", hash: "0001", sql: INIT },
];

const SCHEMA_VERSION = `
CREATE TABLE IF NOT EXISTS billing_schema_version (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

/** The SQL a dry run prints, in apply order. */
export const migrateDryRun = (): string =>
  [SCHEMA_VERSION, ...migrationFiles.map((file) => file.sql)].join("\n");

/**
 * Apply every file that is not in `billing_schema_version`, in one guarded
 * transaction per file. An applied file is never edited; the version row is
 * the record.
 */
export const migrate = (
  sql: SqlExecutor,
  now: () => number,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.sync(() => {
    sql.exec(SCHEMA_VERSION);
    const applied: Array<string> = [];
    for (const file of migrationFiles) {
      const seen = sql.get<{ version: string }>(
        "SELECT version FROM billing_schema_version WHERE version = ?",
        [file.id],
      );
      if (seen !== undefined) continue;
      sql.transaction(() => {
        sql.exec(file.sql);
        sql.run("INSERT INTO billing_schema_version (version, applied_at) VALUES (?, ?)", [
          file.id,
          now(),
        ]);
      });
      applied.push(file.id);
    }
    return applied;
  });
