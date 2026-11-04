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
