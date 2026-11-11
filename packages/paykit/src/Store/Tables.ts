// Identifier quoting is Alchemy's own (`quoteIdentifier` in
// `@alchemy.run/sql/Migrations`), so a dialect the registry knows is a dialect
// paykit renders correctly. Only the schema-qualified naming rule is local.
// Source: https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.85/packages/sql/src/Migrations/Utils.ts
import { quoteIdentifier } from "@alchemy.run/sql/Migrations";
import type { SqlDialect } from "./Sql.ts";

/**
 * The two table classes from the storage contract: `billing_event` is the
 * append-only truth and every `billing_rm_*` table is rebuildable from it.
 * Bookkeeping tables are named beside them so one schema holds everything.
 */
export const BILLING_TABLES = {
  event: "billing_event",
  receipt: "billing_receipt",
  state: "billing_state",
  outbox: "billing_outbox",
  schedule: "billing_schedule",
  readModel: "billing_rm_billing_read",
  schemaVersion: "billing_schema_version",
  // Consumer state. Every one of these is rebuildable from `billing_event`:
  // a view, projection, policy dedupe row or stream is a fold, never truth.
  viewState: "billing_rm_view_state",
  viewEntry: "billing_rm_view_entry",
  viewInput: "billing_rm_view_input",
  /** Downstream deliveries a view committed, until their targets accept them. */
  viewOutbox: "billing_rm_view_outbox",
  /** Which consumer generations have been caught up from history. */
  backfill: "billing_rm_backfill",
  projectionInput: "billing_rm_projection_input",
  projectionCursor: "billing_rm_projection_cursor",
  policySeen: "billing_rm_policy_seen",
  streamMeta: "billing_rm_stream_meta",
  streamEntry: "billing_rm_stream_entry",
} as const;

export type BillingTable = (typeof BILLING_TABLES)[keyof typeof BILLING_TABLES];

/** Where paykit's tables live. SQLite has no schemas; Postgres qualifies. */
export interface TableScope {
  readonly dialect: SqlDialect;
  /**
   * The Postgres schema holding every `billing_*` table. `public` is never
   * touched. SQLite ignores this field.
   */
  readonly schema?: string;
}

/** The schema every Postgres store uses unless the caller names another. */
export const DEFAULT_SCHEMA = "billing";

/** A schema name that is safe to interpolate into quoted DDL. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/** A schema name is an identifier, never a fragment of SQL. */
export const isSchemaName = (schema: string): boolean =>
  schema !== "public" && SCHEMA_NAME.test(schema);

export { quoteIdentifier };

/**
 * Resolve a logical table to the identifier a statement should use. Postgres
 * qualifies with the schema; MySQL's namespace is the connection's database, so
 * the table is quoted and left unqualified; SQLite has no schema either.
 */
export const tableName = (table: string, scope: TableScope): string =>
  scope.dialect === "postgres" && scope.schema !== undefined
    ? `${quoteIdentifier(scope.schema, scope.dialect)}.${quoteIdentifier(table, scope.dialect)}`
    : quoteIdentifier(table, scope.dialect);

/**
 * The columns this schema names that a dialect reserves: MySQL parses `KEY`
 * and `VIEW` as keywords, so a statement that names them as columns must quote
 * them. A quoted identifier parses on every dialect, so exactly these are
 * quoted everywhere and the rest stay bare, which keeps a statement readable.
 * A new reserved name is added here — writing `key` or `view` by hand is the
 * bug this prevents.
 */
const RESERVED_COLUMNS: ReadonlySet<string> = new Set(["key", "view"]);

/** A column name as a statement must spell it. */
export const columnIdentifier = (column: string, dialect: SqlDialect): string =>
  RESERVED_COLUMNS.has(column) ? quoteIdentifier(column, dialect) : column;

/** Render a string as a SQL literal for the rare statement a driver batches. */
export const stringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
