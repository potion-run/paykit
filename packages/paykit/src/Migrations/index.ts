// The apply pipeline and its error taxonomy are Alchemy's, pinned by the
// workspace catalog at v2.0.0-beta.85: applyAlchemyFormat, MigrationRecord,
// MigrationError and RewrittenMigrationHistoryError all come from
// @alchemy.run/sql/Migrations. The adapter below mirrors that package's
// SqlExecutor contract so an upstream bump is a diff, not a fork.
// Source: https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.85/packages/sql/src/Migrations/Format.ts
// Mirrored locally at .agent_sources/github.com/alchemy-run/alchemy/.
import {
  applyAlchemyFormat,
  MigrationError,
  timestampPrefixMillis,
  type MigrationApplyError,
  type MigrationRecord,
  type SqlExecutor as MigrationSqlExecutor,
} from "@alchemy.run/sql/Migrations";
import { sha256 } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import type { SqlDialect, SqlExecutor, SqlValue } from "../Store/Sql.ts";
import {
  BILLING_TABLES,
  DEFAULT_SCHEMA,
  isSchemaName,
  quoteIdentifier,
  tableName,
} from "../Store/Tables.ts";

/** Where a migration's DDL is rendered: a dialect and, on Postgres, a schema. */
export interface MigrationScope {
  readonly dialect: SqlDialect;
  /**
   * The Postgres schema every `billing_*` table lives in. `public` is refused;
   * SQLite has no schemas and ignores this field.
   */
  readonly schema?: string;
  /**
   * The applied-migrations table. The name is paykit's, the column shape is
   * Alchemy's (`id, hash, created_at, name, applied_at`), so the registry's
   * drift detection and legacy upgrades come for free.
   */
  readonly table?: string;
}

/** Options for applying migrations; the executor supplies the dialect. */
export interface MigrateOptions {
  /** The Postgres schema. Ignored by SQLite. */
  readonly schema?: string;
  /** The applied-migrations table. */
  readonly table?: string;
}

/** One migration: its statements, and the canonical SQL they hash to. */
export interface MigrationFile {
  readonly id: string;
  readonly sql: string;
  readonly statements: ReadonlyArray<string>;
}

const DEFAULT_MIGRATION_TABLE = BILLING_TABLES.schemaVersion;

const scopeOf = (input: Partial<MigrationScope> | undefined): Required<MigrationScope> => ({
  dialect: input?.dialect ?? "sqlite",
  schema: input?.schema ?? DEFAULT_SCHEMA,
  table: input?.table ?? DEFAULT_MIGRATION_TABLE,
});

const millisType = (dialect: SqlDialect): "BIGINT" | "INTEGER" =>
  // Postgres INTEGER is 32-bit; every epoch-millis column needs 64.
  dialect === "postgres" ? "BIGINT" : "INTEGER";

const createTable = (
  scope: Required<MigrationScope>,
  table: string,
  columns: ReadonlyArray<string>,
): string => `CREATE TABLE IF NOT EXISTS ${tableName(table, scope)} (${columns.join(", ")})`;

const createIndex = (
  scope: Required<MigrationScope>,
  name: string,
  on: string,
  columns: ReadonlyArray<string>,
): string =>
  `CREATE INDEX IF NOT EXISTS ${tableName(name, scope)} ON ${tableName(on, scope)} (${columns.join(", ")})`;

/** The schema creation, before any table. Postgres only. */
export const schemaStatements = (scope: Required<MigrationScope>): ReadonlyArray<string> =>
  scope.dialect === "postgres"
    ? [`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(scope.schema)}`]
    : [];

const initStatements = (scope: Required<MigrationScope>): ReadonlyArray<string> => {
  const time = millisType(scope.dialect);
  return [
    createTable(scope, BILLING_TABLES.event, [
      "aggregate TEXT NOT NULL",
      "account TEXT NOT NULL",
      "seq INTEGER NOT NULL",
      "command_id TEXT NOT NULL",
      `at ${time} NOT NULL`,
      "event TEXT NOT NULL",
      "PRIMARY KEY (aggregate, account, seq)",
    ]),
    createIndex(scope, "billing_event_command", BILLING_TABLES.event, [
      "aggregate",
      "account",
      "command_id",
    ]),
    createTable(scope, BILLING_TABLES.receipt, [
      "aggregate TEXT NOT NULL",
      "account TEXT NOT NULL",
      "command_id TEXT NOT NULL",
      "version INTEGER NOT NULL",
      "receipt TEXT NOT NULL",
      "PRIMARY KEY (aggregate, account, command_id)",
    ]),
    createTable(scope, BILLING_TABLES.state, [
      "aggregate TEXT NOT NULL",
      "account TEXT NOT NULL",
      "version INTEGER NOT NULL",
      "state TEXT NOT NULL",
      "PRIMARY KEY (aggregate, account)",
    ]),
    createTable(scope, BILLING_TABLES.outbox, [
      "seq INTEGER PRIMARY KEY",
      "aggregate TEXT NOT NULL",
      "account TEXT NOT NULL",
      "event_seq INTEGER NOT NULL",
      "delivery TEXT NOT NULL",
      `delivered_at ${time}`,
    ]),
    createIndex(scope, "billing_outbox_pending", BILLING_TABLES.outbox, ["delivered_at", "seq"]),
    createTable(scope, BILLING_TABLES.schedule, [
      "aggregate TEXT NOT NULL",
      "account TEXT NOT NULL",
      "command_id TEXT NOT NULL",
      `due_at ${time} NOT NULL`,
      "command TEXT NOT NULL",
      `delivered_at ${time}`,
      "PRIMARY KEY (aggregate, account, command_id)",
    ]),
    createIndex(scope, "billing_schedule_due", BILLING_TABLES.schedule, ["delivered_at", "due_at"]),
    createTable(scope, BILLING_TABLES.readModel, [
      "account TEXT PRIMARY KEY",
      "tier TEXT NOT NULL",
      "status TEXT NOT NULL",
      "standing TEXT NOT NULL",
      `period_start ${time} NOT NULL`,
      `period_end ${time} NOT NULL`,
      "cancel_at_period_end INTEGER NOT NULL",
      "credits INTEGER NOT NULL",
      "currency TEXT",
      "features TEXT NOT NULL",
    ]),
    createIndex(scope, "billing_rm_billing_read_standing", BILLING_TABLES.readModel, [
      "standing",
      "tier",
    ]),
    ...consumerStatements(scope),
  ];
};

/**
 * The consumer tables: a view's snapshot, its emitted entries, and the input
 * log each consumer dedupes by. All of them are `billing_rm_*`, so dropping
 * every one and rebuilding from `billing_event` is always allowed.
 */
const consumerStatements = (scope: Required<MigrationScope>): ReadonlyArray<string> => {
  const time = millisType(scope.dialect);
  const name = scope.dialect === "postgres" && scope.schema !== undefined;
  const table = (logical: string) =>
    name ? `${quoteIdentifier(scope.schema!)}.${quoteIdentifier(logical)}` : logical;
  return [
    `CREATE TABLE IF NOT EXISTS ${table(BILLING_TABLES.viewState)} (
      view TEXT NOT NULL,
      key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      version INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      checkpoints TEXT NOT NULL,
      state TEXT,
      PRIMARY KEY (view, key)
    )`,
    `CREATE TABLE IF NOT EXISTS ${table(BILLING_TABLES.viewEntry)} (
      view TEXT NOT NULL,
      key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      envelope TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (view, key, seq)
    )`,
    `CREATE TABLE IF NOT EXISTS ${table(BILLING_TABLES.viewInput)} (
      view TEXT NOT NULL,
      key TEXT NOT NULL,
      source TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      PRIMARY KEY (view, key, source, source_seq)
    )`,
    `CREATE TABLE IF NOT EXISTS ${table(BILLING_TABLES.projectionInput)} (
      projection TEXT NOT NULL,
      key TEXT NOT NULL,
      source TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      position INTEGER NOT NULL,
      delivery TEXT NOT NULL,
      accepted_at ${time} NOT NULL,
      processed_at ${time},
      PRIMARY KEY (projection, key, source, source_seq)
    )`,
    `CREATE INDEX IF NOT EXISTS ${table("billing_rm_projection_pending")}
      ON ${table(BILLING_TABLES.projectionInput)} (projection, key, processed_at, position)`,
    `CREATE TABLE IF NOT EXISTS ${table(BILLING_TABLES.projectionCursor)} (
      projection TEXT NOT NULL,
      key TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (projection, key)
    )`,
    `CREATE TABLE IF NOT EXISTS ${table(BILLING_TABLES.policySeen)} (
      policy TEXT NOT NULL,
      key TEXT NOT NULL,
      source TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      PRIMARY KEY (policy, key, source, source_seq)
    )`,
    `CREATE TABLE IF NOT EXISTS ${table(BILLING_TABLES.streamMeta)} (
      stream TEXT NOT NULL,
      key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      checkpoints TEXT NOT NULL,
      origin_a INTEGER NOT NULL,
      origin_b INTEGER NOT NULL,
      PRIMARY KEY (stream, key)
    )`,
    `CREATE TABLE IF NOT EXISTS ${table(BILLING_TABLES.streamEntry)} (
      stream TEXT NOT NULL,
      key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      envelope TEXT NOT NULL,
      PRIMARY KEY (stream, key, seq)
    )`,
  ];
};

/**
 * The migrations paykit ships, rendered for a dialect and schema. The list is
 * additive: a change appends a file, it never edits one already in the list.
 *
 * @primitive
 * @example
 * ```ts
 * import { migrationFiles } from "@potion.run/paykit"
 *
 * const [init] = migrationFiles({ dialect: "sqlite" })
 * console.log(init.id, init.sql)
 * ```
 */
export const migrationFiles = (input?: Partial<MigrationScope>): ReadonlyArray<MigrationFile> => {
  const scope = scopeOf(input);
  const statements = initStatements(scope);
  return [{ id: "0001_init", statements, sql: statements.join(";\n") + ";" }];
};

/**
 * Read the shipped migrations as `@alchemy.run/sql` records: content-hashed,
 * carrying their statements for the dialect, and keyed for drift detection.
 */
export const readMigrationFiles = (
  input?: Partial<MigrationScope>,
): Effect.Effect<ReadonlyArray<MigrationRecord>> => {
  const scope = scopeOf(input);
  return Effect.forEach(migrationFiles(scope), (file) =>
    Effect.map(sha256(file.sql), (hash) => ({
      name: file.id,
      hash,
      createdAtMillis: timestampPrefixMillis(file.id),
      sql: file.sql,
      statements: [...file.statements],
    })),
  );
};

/**
 * The SQL a dry run prints, in apply order: the schema, then every migration
 * with its id as a comment. The applied-migrations table is created by
 * `@alchemy.run/sql` and is not part of the money-table DDL.
 *
 * @primitive
 * @example
 * ```ts
 * import { migrateDryRun } from "@potion.run/paykit"
 *
 * console.log(migrateDryRun({ dialect: "postgres", schema: "billing" }))
 * ```
 */
export const migrateDryRun = (input?: Partial<MigrationScope>): string => {
  const scope = scopeOf(input);
  const lines = [
    `-- paykit billing schema (${scope.dialect}${scope.dialect === "postgres" ? `, schema ${scope.schema}` : ""})`,
    `-- bookkeeping: ${scope.table} (managed by @alchemy.run/sql/Migrations)`,
    ...schemaStatements(scope),
  ];
  for (const file of migrationFiles(scope)) {
    lines.push(`-- ${file.id}`, file.sql);
  }
  return lines.join("\n");
};

const describeCause = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const { message, _tag } = cause as { message?: unknown; _tag?: unknown };
    if (typeof message === "string" && message.length > 0) return message;
    if (typeof _tag === "string") return _tag;
  }
  return String(cause);
};

/**
 * Adapt the store's synchronous `SqlExecutor` into the registry's Effect
 * executor. `batch` is the atomic unit both Alchemy and paykit rely on: a
 * migration's statements and its bookkeeping row commit together.
 */
const migrationExecutor = (
  sql: SqlExecutor,
  scope: Required<MigrationScope>,
): MigrationSqlExecutor => ({
  dialect: scope.dialect,
  ...(scope.dialect === "postgres" ? { defaultSchema: scope.schema } : {}),
  transactionalDdl: true,
  query: (statement, params) =>
    Effect.try({
      try: () => [
        ...sql.all<Record<string, unknown>>(statement, (params ?? []) as ReadonlyArray<SqlValue>),
      ],
      catch: (cause) =>
        new MigrationError({
          message: `${scope.dialect} query failed: ${describeCause(cause)}`,
          cause,
        }),
    }),
  batch: (statements) =>
    Effect.try({
      try: () => {
        if (sql.batch !== undefined) {
          sql.batch(statements);
          return;
        }
        sql.transaction(() => {
          for (const statement of statements) sql.exec(statement);
        });
      },
      catch: (cause) =>
        new MigrationError({
          message: `${scope.dialect} migration batch failed: ${describeCause(cause)}`,
          cause,
        }),
    }),
});

const tryExec = (
  sql: SqlExecutor,
  statement: string,
  migration = "setup",
): Effect.Effect<void, MigrationError> =>
  Effect.try({
    try: () => sql.exec(statement),
    catch: (cause) =>
      new MigrationError({
        message: `migration ${migration} failed: ${describeCause(cause)}`,
        cause,
      }),
  });

const tryRun = (
  sql: SqlExecutor,
  statement: string,
  params: ReadonlyArray<SqlValue>,
  migration = "setup",
): Effect.Effect<void, MigrationError> =>
  Effect.try({
    try: () => sql.run(statement, params),
    catch: (cause) =>
      new MigrationError({
        message: `migration ${migration} failed: ${describeCause(cause)}`,
        cause,
      }),
  });

const readSearchPath = (sql: SqlExecutor): Effect.Effect<string | undefined, MigrationError> =>
  Effect.try({
    try: () => sql.get<{ search_path: string }>("SHOW search_path")?.search_path,
    catch: (cause) =>
      new MigrationError({
        message: `could not read search_path: ${describeCause(cause)}`,
        cause,
      }),
  });

const useSearchPath = <A, E, R>(
  sql: SqlExecutor,
  schema: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MigrationError, R> =>
  Effect.gen(function* () {
    const previous = yield* readSearchPath(sql);
    yield* tryRun(sql, "SELECT set_config('search_path', ?, false)", [schema]);
    return yield* effect.pipe(
      Effect.ensuring(
        previous === undefined
          ? Effect.void
          : Effect.orElseSucceed(
              tryRun(sql, "SELECT set_config('search_path', ?, false)", [previous]),
              () => undefined,
            ),
      ),
    );
  });

const normalizeScope = (
  input: MigrateOptions | undefined,
  dialect: SqlDialect,
): Effect.Effect<Required<MigrationScope>, MigrationError> => {
  const scope = scopeOf({
    dialect,
    schema: input?.schema,
    table: input?.table,
  });
  if (scope.dialect === "postgres" && !isSchemaName(scope.schema)) {
    return Effect.fail(
      new MigrationError({
        message: `"${scope.schema}" is not a safe Postgres schema name; refusing to touch it`,
      }),
    );
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(scope.table)) {
    return Effect.fail(
      new MigrationError({
        message: `"${scope.table}" is not a safe applied-migrations table name`,
      }),
    );
  }
  return Effect.succeed(scope);
};

const readAppliedNames = (
  sql: SqlExecutor,
  scope: Required<MigrationScope>,
): ReadonlyArray<string> => {
  const table = tableName(scope.table, scope);
  try {
    return sql
      .all<{ name: string }>(`SELECT name FROM ${table} ORDER BY name ASC`)
      .map((row) => row.name);
  } catch {
    // The registry creates the table; before the first run it does not exist.
    // The oldest Alchemy shape carries the name in `id`, so read that too —
    // otherwise a legacy upgrade would look like a fresh application.
    try {
      return sql
        .all<{ name: string }>(`SELECT id AS name FROM ${table} ORDER BY id ASC`)
        .map((row) => row.name);
    } catch {
      return [];
    }
  }
};

/** Name the pending file a registry failure belongs to, keeping its tag. */
const annotate = (error: MigrationApplyError, pending: string | undefined): MigrationApplyError =>
  error._tag === "MigrationError"
    ? new MigrationError({
        message: `${pending ?? "migration"} failed: ${error.message}`,
        cause: error,
        ...(error.transient === undefined ? {} : { transient: error.transient }),
      })
    : error;

/**
 * Apply every pending migration through `@alchemy.run/sql/Migrations`, which
 * owns the bookkeeping, content-hash drift detection and legacy upgrades. Each
 * file's statements and its bookkeeping row commit together, so a failed file
 * leaves no record and is retried on the next run.
 *
 * The returned ids are the migrations this call records as applied; an
 * already-applied file is not returned, and a replay returns an empty array.
 * `schema` defaults to `billing` on Postgres and is ignored by SQLite.
 *
 * On Postgres the executor must route every statement to one session (a
 * dedicated migration connection): the registry's bookkeeping queries are
 * unqualified, so this call scopes `search_path` and restores it afterwards.
 *
 * @primitive
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { migrate } from "@potion.run/paykit"
 *
 * const applied = yield* migrate(sqliteExecutor)
 * if (applied.length > 0) console.log("applied", applied)
 * ```
 */
export const migrate = Effect.fn("Paykit.migrate")(function* (
  sql: SqlExecutor,
  input?: MigrateOptions,
) {
  const scope = yield* normalizeScope(input, sql.dialect);
  const records = yield* readMigrationFiles(scope);
  const before = new Set(readAppliedNames(sql, scope));
  const executor = migrationExecutor(sql, scope);
  const pending = records.find((record) => !before.has(record.name))?.name;

  const apply = Effect.gen(function* () {
    if (scope.dialect === "postgres") {
      for (const statement of schemaStatements(scope)) {
        yield* tryExec(sql, statement);
      }
    }
    yield* applyAlchemyFormat({ executor, table: scope.table, records }).pipe(
      Effect.mapError((error) => annotate(error, pending)),
    );
  });

  if (scope.dialect === "postgres") {
    yield* useSearchPath(sql, scope.schema, apply);
  } else {
    yield* apply;
  }

  return readAppliedNames(sql, scope).filter((name) => !before.has(name));
});

export {
  MigrationError,
  MigrationHistoryConflictError,
  RewrittenMigrationHistoryError,
} from "@alchemy.run/sql/Migrations";
export type { MigrationApplyError, MigrationRecord } from "@alchemy.run/sql/Migrations";
