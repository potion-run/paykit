// The billing DDL is data: one typed description renders per dialect, so the
// SQLite file and the Postgres file cannot drift from each other or from a
// test. Table names, identifier quoting and schema qualification come from
// `Store/Tables.ts`; this file owns the columns and the emission order.
// The two table classes are the storage contract in packages/paykit/AGENTS.md:
// `billing_event` is the only truth and every `billing_rm_*` table is a fold
// that can be rebuilt from it.
import type { SqlDialect } from "../Store/Sql.ts";
import { BILLING_TABLES, quoteIdentifier, tableName, type TableScope } from "../Store/Tables.ts";

/**
 * The storage class of a column. `millis` is an epoch-millis instant, so
 * Postgres needs 64 bits where SQLite's INTEGER is already 64; `serial` is a
 * surrogate key whose syntax differs per dialect.
 */
export type ColumnType = "text" | "integer" | "millis" | "boolean" | "serial";

/** One column: its name, its storage class, and the constraints it carries. */
export interface Column {
  readonly name: string;
  readonly type: ColumnType;
  readonly notNull?: boolean;
  /** A single-column primary key. A `serial` column carries its own. */
  readonly primaryKey?: boolean;
  /** A numeric default, rendered as `DEFAULT <n>`. */
  readonly default?: number;
}

/** One table, with a composite primary key when the key spans columns. */
export interface Table {
  readonly name: string;
  readonly columns: ReadonlyArray<Column>;
  readonly primaryKey?: ReadonlyArray<string>;
}

/** One index. `on` is the logical table name, never a qualified identifier. */
export interface Index {
  readonly name: string;
  readonly on: string;
  readonly columns: ReadonlyArray<string>;
}

/**
 * A whole schema description. `items` is the emission order, so a table is
 * followed by its indexes and the projection index sits beside its table.
 */
export interface SchemaDefinition {
  readonly name: string;
  readonly items: ReadonlyArray<Table | Index>;
}

const table = (
  name: string,
  columns: ReadonlyArray<Column>,
  primaryKey?: ReadonlyArray<string>,
): Table => (primaryKey === undefined ? { name, columns } : { name, columns, primaryKey });

const index = (name: string, on: string, columns: ReadonlyArray<string>): Index => ({
  name,
  on,
  columns,
});

const isIndex = (item: Table | Index): item is Index => "on" in item;

/** The tables of a description, in emission order. */
export const tablesOf = (schema: SchemaDefinition): ReadonlyArray<Table> =>
  schema.items.filter((item): item is Table => !isIndex(item));

/** The indexes of a description, in emission order. */
export const indexesOf = (schema: SchemaDefinition): ReadonlyArray<Index> =>
  schema.items.filter(isIndex);

const typeOf = (type: ColumnType, dialect: SqlDialect): string => {
  switch (type) {
    case "text":
      return "TEXT";
    case "integer":
      return "INTEGER";
    case "boolean":
      // SQLite has no boolean storage class; INTEGER is the dialect's own
      // spelling and leaves the column unchanged on a dialect move.
      return dialect === "postgres" ? "BOOLEAN" : "INTEGER";
    case "millis":
      return dialect === "postgres" ? "BIGINT" : "INTEGER";
    case "serial":
      return dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  }
};

/**
 * One column's definition, as it appears inside `CREATE TABLE`. Exposed so a
 * convergence `ALTER TABLE ADD COLUMN` renders the same type and constraints
 * the shipped migration does.
 */
export const columnStatement = (column: Column, dialect: SqlDialect): string => {
  const parts = [quoteIdentifier(column.name), typeOf(column.type, dialect)];

  if (column.notNull === true) parts.push("NOT NULL");

  if (column.default !== undefined) parts.push(`DEFAULT ${column.default}`);

  if (column.primaryKey === true) parts.push("PRIMARY KEY");

  return parts.join(" ");
};

/** One table's `CREATE TABLE IF NOT EXISTS` statement. */
export const tableStatement = (entry: Table, scope: TableScope): string => {
  const columns = entry.columns.map((column) => columnStatement(column, scope.dialect));

  const key =
    entry.primaryKey === undefined
      ? []
      : [`PRIMARY KEY (${entry.primaryKey.map(quoteIdentifier).join(", ")})`];

  // One line per table: the file is read as a schema, and a column's
  // constraints are easier to compare when the row is not wrapped.
  return `CREATE TABLE IF NOT EXISTS ${tableName(entry.name, scope)} (${[...columns, ...key].join(", ")})`;
};

/** One index's `CREATE INDEX IF NOT EXISTS` statement. */
export const indexStatement = (entry: Index, scope: TableScope): string =>
  // An index name is never schema-qualified: the index lands in its table's
  // schema, and `CREATE INDEX "schema"."name"` is a syntax error on Postgres.
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(entry.name)} ON ${tableName(entry.on, scope)} (${entry.columns.map(quoteIdentifier).join(", ")})`;

/**
 * Render a description as one CREATE statement per table and per index, in
 * `items` order, with every identifier quoted and every Postgres table
 * schema-qualified. Statements carry no trailing `;`.
 */
export const schemaStatementsOf = (
  schema: SchemaDefinition,
  scope: TableScope,
): ReadonlyArray<string> =>
  schema.items.map((item) =>
    isIndex(item) ? indexStatement(item, scope) : tableStatement(item, scope),
  );

/**
 * Every table and index paykit's billing store owns. The order is the
 * migration's emission order, so it is also the order a reader sees: the log
 * and its delivery tables first, then the rebuildable read models.
 */
export const BILLING_SCHEMA: SchemaDefinition = {
  name: "paykit-billing",
  items: [
    // The append-only truth. Nothing here is rebuilt; a delivery row is the
    // outbox that makes a crash between commit and send replay, not drop.
    table(
      BILLING_TABLES.event,
      [
        { name: "aggregate", type: "text", notNull: true },
        { name: "account", type: "text", notNull: true },
        { name: "seq", type: "integer", notNull: true },
        { name: "command_id", type: "text", notNull: true },
        { name: "at", type: "millis", notNull: true },
        { name: "event", type: "text", notNull: true },
      ],
      ["aggregate", "account", "seq"],
    ),
    index("billing_event_command", BILLING_TABLES.event, ["aggregate", "account", "command_id"]),
    table(
      BILLING_TABLES.receipt,
      [
        { name: "aggregate", type: "text", notNull: true },
        { name: "account", type: "text", notNull: true },
        { name: "command_id", type: "text", notNull: true },
        { name: "version", type: "integer", notNull: true },
        { name: "receipt", type: "text", notNull: true },
      ],
      ["aggregate", "account", "command_id"],
    ),
    table(
      BILLING_TABLES.state,
      [
        { name: "aggregate", type: "text", notNull: true },
        { name: "account", type: "text", notNull: true },
        { name: "version", type: "integer", notNull: true },
        { name: "state", type: "text", notNull: true },
      ],
      ["aggregate", "account"],
    ),
    table(BILLING_TABLES.outbox, [
      { name: "seq", type: "serial" },
      { name: "aggregate", type: "text", notNull: true },
      { name: "account", type: "text", notNull: true },
      { name: "event_seq", type: "integer", notNull: true },
      { name: "delivery", type: "text", notNull: true },
      { name: "delivered_at", type: "millis" },
    ]),
    index("billing_outbox_pending", BILLING_TABLES.outbox, ["delivered_at", "seq"]),
    table(
      BILLING_TABLES.schedule,
      [
        { name: "aggregate", type: "text", notNull: true },
        { name: "account", type: "text", notNull: true },
        { name: "command_id", type: "text", notNull: true },
        { name: "due_at", type: "millis", notNull: true },
        { name: "command", type: "text", notNull: true },
        { name: "delivered_at", type: "millis" },
      ],
      ["aggregate", "account", "command_id"],
    ),
    index("billing_schedule_due", BILLING_TABLES.schedule, ["delivered_at", "due_at"]),

    // The cross-account read model: one row per account for the admin list.
    table(BILLING_TABLES.readModel, [
      { name: "account", type: "text", primaryKey: true },
      { name: "tier", type: "text", notNull: true },
      { name: "status", type: "text", notNull: true },
      { name: "standing", type: "text", notNull: true },
      { name: "period_start", type: "millis", notNull: true },
      { name: "period_end", type: "millis", notNull: true },
      { name: "cancel_at_period_end", type: "integer", notNull: true },
      { name: "credits", type: "integer", notNull: true },
      { name: "prepaid_credits", type: "integer", notNull: true },
      { name: "dunning_attempts", type: "integer", notNull: true },
      { name: "proration", type: "text" },
      { name: "proration_invoice", type: "text" },
      { name: "currency", type: "text" },
      { name: "features", type: "text", notNull: true },
      { name: "entities", type: "text" },
    ]),
    index("billing_rm_billing_read_standing", BILLING_TABLES.readModel, ["standing", "tier"]),
    table(BILLING_TABLES.backfill, [
      { name: "consumer", type: "text", primaryKey: true },
      { name: "generation", type: "integer", notNull: true },
      { name: "plan", type: "text", notNull: true },
      { name: "completed_at", type: "millis", notNull: true },
    ]),
    table(BILLING_TABLES.viewOutbox, [
      { name: "seq", type: "serial" },
      { name: "view", type: "text", notNull: true },
      { name: "key", type: "text", notNull: true },
      { name: "entry_seq", type: "integer", notNull: true },
      { name: "delivery", type: "text", notNull: true },
      { name: "delivered_at", type: "millis" },
    ]),
    index("billing_rm_view_outbox_pending", BILLING_TABLES.viewOutbox, [
      "view",
      "key",
      "delivered_at",
      "seq",
    ]),

    // Consumer state: a view's snapshot, its entries and the input log it
    // dedupes by. Every one is `billing_rm_*`, so dropping it is always legal.
    table(
      BILLING_TABLES.viewState,
      [
        { name: "view", type: "text", notNull: true },
        { name: "key", type: "text", notNull: true },
        { name: "generation", type: "integer", notNull: true },
        { name: "version", type: "integer", notNull: true },
        { name: "seq", type: "integer", notNull: true },
        { name: "checkpoints", type: "text", notNull: true },
        { name: "state", type: "text" },
      ],
      ["view", "key"],
    ),
    table(
      BILLING_TABLES.viewEntry,
      [
        { name: "view", type: "text", notNull: true },
        { name: "key", type: "text", notNull: true },
        { name: "seq", type: "integer", notNull: true },
        // Absent generation is 0, so a row written before generations existed
        // belongs to the same generation a fresh view starts at.
        { name: "generation", type: "integer", notNull: true, default: 0 },
        { name: "event", type: "text", notNull: true },
        { name: "envelope", type: "text", notNull: true },
        { name: "state", type: "text", notNull: true },
      ],
      ["view", "key", "seq"],
    ),
    table(
      BILLING_TABLES.viewInput,
      [
        { name: "view", type: "text", notNull: true },
        { name: "key", type: "text", notNull: true },
        { name: "source", type: "text", notNull: true },
        { name: "source_seq", type: "integer", notNull: true },
        { name: "generation", type: "integer", notNull: true },
      ],
      ["view", "key", "source", "source_seq"],
    ),
    table(
      BILLING_TABLES.projectionInput,
      [
        { name: "projection", type: "text", notNull: true },
        { name: "key", type: "text", notNull: true },
        { name: "source", type: "text", notNull: true },
        { name: "source_seq", type: "integer", notNull: true },
        { name: "generation", type: "integer", notNull: true },
        { name: "position", type: "integer", notNull: true },
        { name: "delivery", type: "text", notNull: true },
        { name: "accepted_at", type: "millis", notNull: true },
        { name: "processed_at", type: "millis" },
      ],
      ["projection", "key", "source", "source_seq"],
    ),
    // The projection's pending index sits with its table, not after every
    // consumer table, so a reader sees the scan it serves in one place.
    index("billing_rm_projection_pending", BILLING_TABLES.projectionInput, [
      "projection",
      "key",
      "processed_at",
      "position",
    ]),
    table(
      BILLING_TABLES.projectionCursor,
      [
        { name: "projection", type: "text", notNull: true },
        { name: "key", type: "text", notNull: true },
        { name: "position", type: "integer", notNull: true },
      ],
      ["projection", "key"],
    ),
    table(
      BILLING_TABLES.policySeen,
      [
        { name: "policy", type: "text", notNull: true },
        { name: "key", type: "text", notNull: true },
        { name: "source", type: "text", notNull: true },
        { name: "source_seq", type: "integer", notNull: true },
      ],
      ["policy", "key", "source", "source_seq"],
    ),
    table(
      BILLING_TABLES.streamMeta,
      [
        { name: "stream", type: "text", notNull: true },
        { name: "key", type: "text", notNull: true },
        { name: "seq", type: "integer", notNull: true },
        { name: "checkpoints", type: "text", notNull: true },
        { name: "origin_a", type: "integer", notNull: true },
        { name: "origin_b", type: "integer", notNull: true },
      ],
      ["stream", "key"],
    ),
    table(
      BILLING_TABLES.streamEntry,
      [
        { name: "stream", type: "text", notNull: true },
        { name: "key", type: "text", notNull: true },
        { name: "seq", type: "integer", notNull: true },
        { name: "event", type: "text", notNull: true },
        { name: "envelope", type: "text", notNull: true },
      ],
      ["stream", "key", "seq"],
    ),
  ],
};
