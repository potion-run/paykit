// `quoteIdentifier` and the schema-qualified naming rules mirror Alchemy's
// Migrations/Utils.ts. Kept small and local because paykit's table set is
// fixed; the migration registry itself is imported, not copied.
// Source: https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.85/packages/sql/src/Migrations/Utils.ts
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

/** Quote one SQL identifier. Double quotes work on SQLite and Postgres. */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Resolve a logical table or index to the identifier a statement should use. */
export const tableName = (table: string, scope: TableScope): string =>
  scope.dialect === "postgres" && scope.schema !== undefined
    ? `${quoteIdentifier(scope.schema)}.${quoteIdentifier(table)}`
    : quoteIdentifier(table);

/** Render a string as a SQL literal for the rare statement a driver batches. */
export const stringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
