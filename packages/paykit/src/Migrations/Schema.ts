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

/**
 * The columns a dialect must keep short. MySQL indexes and primary keys cannot
 * include a `TEXT` column without a prefix length, so a key column is a
 * `VARCHAR(191)` there — wide enough for an aggregate name, an account id, a
 * command id (a UUID or a vendor event id) and a tier.
 */
const KEYED_TEXT = "VARCHAR(191)";

const SCALAR_TYPES: Record<Exclude<ColumnType, "text">, Record<SqlDialect, string>> = {
  integer: { sqlite: "INTEGER", postgres: "INTEGER", mysql: "INTEGER" },
  // SQLite has no boolean storage class, so INTEGER is its spelling and reads
  // back as 0/1. MySQL's TINYINT(1) is its boolean spelling, and does too.
  boolean: { sqlite: "INTEGER", postgres: "BOOLEAN", mysql: "TINYINT(1)" },
  // Postgres INTEGER is 32-bit; epoch millis need 64 on both it and MySQL.
  millis: { sqlite: "INTEGER", postgres: "BIGINT", mysql: "BIGINT" },
  serial: {
    sqlite: "INTEGER PRIMARY KEY AUTOINCREMENT",
    postgres: "BIGSERIAL PRIMARY KEY",
    mysql: "BIGINT AUTO_INCREMENT PRIMARY KEY",
  },
};

const typeOf = (type: ColumnType, dialect: SqlDialect, keyed: boolean): string => {
  if (type !== "text") return SCALAR_TYPES[type][dialect];

  if (dialect === "mysql" && keyed) return KEYED_TEXT;

  return "TEXT";
};

/**
 * The column names a table's primary key or any of its indexes uses. MySQL
 * renders those as `VARCHAR(191)` rather than `TEXT`; every other dialect
 * renders a column the same way wherever it appears.
 */
export const keyedColumnsOf = (schema: SchemaDefinition, table: string): ReadonlySet<string> => {
  const entry = tablesOf(schema).find((candidate) => candidate.name === table);
  const keyed = new Set<string>(entry?.primaryKey ?? []);

  for (const column of entry?.columns ?? []) {
    if (column.primaryKey === true) keyed.add(column.name);
  }

  for (const index of indexesOf(schema)) {
    if (index.on !== table) continue;

    for (const column of index.columns) keyed.add(column);
  }

  return keyed;
};

/**
 * One column's definition, as it appears inside `CREATE TABLE`. Exposed so a
 * convergence `ALTER TABLE ADD COLUMN` renders the same type and constraints
 * the shipped migration does.
 */
export const columnStatement = (column: Column, dialect: SqlDialect, keyed = false): string => {
  const parts = [quoteIdentifier(column.name, dialect), typeOf(column.type, dialect, keyed)];

  if (column.notNull === true) parts.push("NOT NULL");

  if (column.default !== undefined) parts.push(`DEFAULT ${column.default}`);

  if (column.primaryKey === true) parts.push("PRIMARY KEY");

  return parts.join(" ");
};

/** One table's `CREATE TABLE IF NOT EXISTS` statement. */
export const tableStatement = (
  entry: Table,
  scope: TableScope,
  schema: SchemaDefinition = BILLING_SCHEMA,
): string => {
  const keyed = keyedColumnsOf(schema, entry.name);

  const columns = entry.columns.map((column) =>
    columnStatement(column, scope.dialect, keyed.has(column.name)),
  );

  const key =
    entry.primaryKey === undefined
      ? []
      : [
          `PRIMARY KEY (${entry.primaryKey.map((name) => quoteIdentifier(name, scope.dialect)).join(", ")})`,
        ];

  // One line per table: the file is read as a schema, and a column's
  // constraints are easier to compare when the row is not wrapped.
  return `CREATE TABLE IF NOT EXISTS ${tableName(entry.name, scope)} (${[...columns, ...key].join(", ")})`;
};

/** One index's `CREATE INDEX` statement. */
export const indexStatement = (entry: Index, scope: TableScope): string => {
  // An index name is never schema-qualified: the index lands in its table's
  // schema, and `CREATE INDEX "schema"."name"` is a syntax error on Postgres.
  const guarded = scope.dialect === "mysql" ? "CREATE INDEX" : "CREATE INDEX IF NOT EXISTS";

  // MySQL 8 has no `CREATE INDEX IF NOT EXISTS`; convergence checks
  // `information_schema.statistics` before it runs the statement instead.
  return `${guarded} ${quoteIdentifier(entry.name, scope.dialect)} ON ${tableName(entry.on, scope)} (${entry.columns.map((name) => quoteIdentifier(name, scope.dialect)).join(", ")})`;
};

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
    isIndex(item) ? indexStatement(item, scope) : tableStatement(item, scope, schema),
  );

/**
 * The first released schema, frozen. It is what `migrationFiles()` renders and
 * what an applied history is keyed by: the registry refuses a changed hash, so
 * this description must never move. A later change edits `BILLING_SCHEMA`, and
 * the deploy's convergence applies it.
 *
 * The order is the migration's emission order, so it is also the order a reader
 * sees: the log and its delivery tables first, then the rebuildable read models.
 */
export const BILLING_SCHEMA_V1: SchemaDefinition = {
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
    // Serves the drain of one aggregate instance: the outbox query filters by
    // aggregate and account before `seq`, so it never reads another account's
    // backlog. It belongs to the first release, not to convergence, because
    // MySQL renders a column an index covers as `VARCHAR(191)`; a `TEXT`
    // column created by `CREATE TABLE` cannot later become keyed, and
    // convergence never alters a column.
    index("billing_outbox_account_pending", BILLING_TABLES.outbox, [
      "aggregate",
      "account",
      "delivered_at",
      "seq",
    ]),
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

/**
 * The schema convergence brings a database to. It is the frozen first release
 * today; a change adds a table or a column here, and convergence applies it
 * without touching `BILLING_SCHEMA_V1` — and therefore every applied history
 * row — which is what lets the baseline stop moving.
 */
const withColumn = (schema: SchemaDefinition, on: string, column: Column): SchemaDefinition => ({
  ...schema,
  items: schema.items.map((item) =>
    "on" in item || item.name !== on ? item : { ...item, columns: [...item.columns, column] },
  ),
});

const withIndex = (schema: SchemaDefinition, entry: Index): SchemaDefinition => ({
  ...schema,
  items: [...schema.items, entry],
});

/**
 * The target schema. It starts at the frozen baseline and adds only the
 * columns a later read model carries; convergence applies the delta, so an
 * existing deployment gets the column without rewriting the baseline.
 */
export const BILLING_SCHEMA: SchemaDefinition = withIndex(
  withColumn(
    withColumn(BILLING_SCHEMA_V1, BILLING_TABLES.readModel, { name: "customer", type: "text" }),
    BILLING_TABLES.readModel,
    { name: "usage_limited", type: "integer", notNull: true, default: 0 },
  ),
  index("billing_rm_billing_read_attention", BILLING_TABLES.readModel, [
    "status",
    "cancel_at_period_end",
    "usage_limited",
  ]),
);
