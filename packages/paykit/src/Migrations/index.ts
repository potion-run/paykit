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
import * as Result from "effect/Result";
import { asyncOf, type SqlDialect, type SqlExecutor, type SqlValue } from "../Store/Sql.ts";
import {
  BILLING_TABLES,
  DEFAULT_SCHEMA,
  isSchemaName,
  quoteIdentifier,
  tableName,
} from "../Store/Tables.ts";
import { converge } from "./Converge.ts";
import {
  BILLING_SCHEMA,
  BILLING_SCHEMA_V1,
  schemaStatementsOf,
  type SchemaDefinition,
} from "./Schema.ts";

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

/** The schema creation, before any table. Postgres only. */
export const schemaStatements = (scope: Required<MigrationScope>): ReadonlyArray<string> =>
  scope.dialect === "postgres"
    ? [`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(scope.schema, scope.dialect)}`]
    : [];

// The DDL is a rendering of the one typed description, so the file a deploy
// applies and the DDL a test or a dry run prints come from the same source.
const initStatements = (scope: Required<MigrationScope>): ReadonlyArray<string> =>
  schemaStatementsOf(BILLING_SCHEMA_V1, scope);

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

  return [fileOf("0001_init", initStatements(scope))];
};

/**
 * The digest of the schema description rendered for a dialect: the DDL a
 * deploy would apply, without the migration wrapper. Two builds that create
 * the same tables hash the same, and adding a column, changing a type or
 * moving a key moves it.
 *
 * `schema` defaults to `BILLING_SCHEMA`; a tool with a candidate description
 * can fingerprint that instead.
 *
 * @primitive
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { schemaFingerprint } from "@potion.run/paykit"
 *
 * const sqlite = yield* schemaFingerprint()
 * const postgres = yield* schemaFingerprint({ dialect: "postgres" })
 * ```
 */
export const schemaFingerprint = (
  input?: Partial<MigrationScope>,
  schema: SchemaDefinition = BILLING_SCHEMA,
): Effect.Effect<string> => {
  const statements = schemaStatementsOf(schema, scopeOf(input));

  return sha256(`${statements.join(";\n")};`);
};

const fileOf = (id: string, statements: ReadonlyArray<string>): MigrationFile => ({
  id,
  statements,
  sql: statements.join(";\n") + ";",
});

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
 * The digest of the shipped migration set for a scope: its file ids, their
 * content hashes, and the dialect, schema and bookkeeping table it was
 * rendered for. It answers "did what we ship change", where
 * `schemaFingerprint` answers "did the table shape change". A schema or table
 * change counts even when the DDL bytes happen to match, because the registry
 * writes history under the table and routes DDL to the schema.
 *
 * @primitive
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { migrationFingerprint } from "@potion.run/paykit"
 *
 * const shipped = yield* migrationFingerprint({ dialect: "postgres", schema: "billing" })
 * ```
 */
export const migrationFingerprint = (input?: Partial<MigrationScope>): Effect.Effect<string> => {
  const scope = scopeOf(input);

  return Effect.gen(function* () {
    const files = yield* readMigrationFiles(scope);

    const payload = {
      dialect: scope.dialect,
      schema: scope.schema,
      table: scope.table,
      files: files.map((file) => ({ id: file.name, hash: file.hash })),
    };

    return yield* sha256(JSON.stringify(payload));
  });
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

/** How far a driver's `cause` chain is walked; a wrapped SQL failure is a few links deep. */
const causeDepth = 8;

/**
 * A failure and every cause beneath it, the root last. A driver wraps its
 * diagnostic: `@effect/sql` reports a missing table as
 * `PgConnection: Query failed` and keeps the `relation … does not exist` on the
 * reason, so a reader that stops at the top layer cannot tell a fresh database
 * from one it may not read.
 */
const causeChain = (cause: unknown): ReadonlyArray<unknown> => {
  const chain: Array<unknown> = [];
  const seen = new Set<unknown>();

  let current: unknown = cause;

  for (let depth = 0; depth < causeDepth; depth += 1) {
    if (seen.has(current)) break;

    seen.add(current);
    chain.push(current);

    if (typeof current !== "object" || current === null) break;

    // SAFETY: a driver's error is untyped at this boundary; only `cause` is read, and a missing one ends the chain.
    current = (current as { cause?: unknown }).cause;
  }

  return chain;
};

/** One link's text: its message, its tag when a tagged error carries none, or a thrown string. */
const describeLink = (link: unknown): string | undefined => {
  if (typeof link === "string") return link.length > 0 ? link : undefined;

  if (typeof link !== "object" || link === null) return undefined;

  // SAFETY: a migration row and an error cause are untyped at the storage boundary; the migration schema owns the value.
  const { message, _tag } = link as { message?: unknown; _tag?: unknown };

  if (typeof message === "string" && message.length > 0) return message;

  if (typeof _tag === "string") return _tag;

  return undefined;
};

const causeDescriptions = (cause: unknown): ReadonlyArray<string> =>
  causeChain(cause)
    .map(describeLink)
    .filter((description): description is string => description !== undefined);

/**
 * The root cause is the specific one — a wrapper names the layer that failed,
 * not the reason — so the deepest description wins.
 */
const describeCause = (cause: unknown): string => causeDescriptions(cause).at(-1) ?? String(cause);

/**
 * The registry runs on whichever half the driver implements. A synchronous
 * driver keeps its own transaction — one `BEGIN IMMEDIATE` around the batch —
 * and a remote driver (Postgres, D1 over HTTP) goes through `asyncOf`'s
 * `batch`, which is its atomic unit. `Paykit.migrate` is therefore the same
 * call on every target.
 */
const isAsync = (sql: SqlExecutor): boolean => sql.query !== undefined;

/**
 * The registry's bookkeeping binds are strings, numbers and null. Narrowing
 * here keeps every adapter honest about the values a migration can bind.
 */
const binds = (params: ReadonlyArray<unknown> | undefined): ReadonlyArray<SqlValue> =>
  // SAFETY: the registry's params are migration bookkeeping values (name, hash, timestamp), never a caller's object.
  (params ?? []) as ReadonlyArray<SqlValue>;

const queryFailure = (scope: Required<MigrationScope>, cause: { readonly message: string }) =>
  new MigrationError({
    message: `${scope.dialect} query failed: ${cause.message}`,
    cause,
  });

const batchFailure = (scope: Required<MigrationScope>, cause: { readonly message: string }) =>
  new MigrationError({
    message: `${scope.dialect} migration batch failed: ${cause.message}`,
    cause,
  });

/**
 * Adapt the store's executor into the registry's Effect executor. `batch` is
 * the atomic unit both Alchemy and paykit rely on: a migration's statements and
 * its bookkeeping row commit together.
 */
const migrationExecutor = (
  sql: SqlExecutor,
  scope: Required<MigrationScope>,
): MigrationSqlExecutor => {
  const defaultSchema = scope.dialect === "postgres" ? { defaultSchema: scope.schema } : {};

  if (!isAsync(sql)) {
    return {
      dialect: scope.dialect,
      ...defaultSchema,
      transactionalDdl: true,
      query: (statement, params) =>
        Effect.try({
          try: () => [...sql.all<Record<string, unknown>>(statement, binds(params))],
          catch: (cause) => queryFailure(scope, { message: describeCause(cause) }),
        }),
      batch: (statements) =>
        Effect.try({
          try: () => {
            sql.transaction(() => {
              for (const statement of statements) sql.exec(statement);
            });
          },
          catch: (cause) => batchFailure(scope, { message: describeCause(cause) }),
        }),
    };
  }

  const port = asyncOf(sql);

  return {
    dialect: scope.dialect,
    ...defaultSchema,
    transactionalDdl: true,
    query: (statement, params) =>
      port.query<Record<string, unknown>>(statement, binds(params)).pipe(
        Effect.map((rows) => [...rows]),
        Effect.mapError((cause) => queryFailure(scope, cause)),
      ),
    batch: (statements) =>
      port.batch(statements).pipe(Effect.mapError((cause) => batchFailure(scope, cause))),
  };
};

const statementFailure = (migration: string, cause: { readonly message: string }) =>
  new MigrationError({
    message: `migration ${migration} failed: ${cause.message}`,
    cause,
  });

const tryExec = (
  sql: SqlExecutor,
  statement: string,
  migration = "setup",
): Effect.Effect<void, MigrationError> =>
  isAsync(sql)
    ? asyncOf(sql)
        .batch([statement])
        .pipe(Effect.mapError((cause) => statementFailure(migration, cause)))
    : Effect.try({
        try: () => {
          sql.exec(statement);
        },
        catch: (cause) => statementFailure(migration, { message: describeCause(cause) }),
      });

const tryRun = (
  sql: SqlExecutor,
  statement: string,
  params: ReadonlyArray<SqlValue>,
  migration = "setup",
): Effect.Effect<void, MigrationError> =>
  isAsync(sql)
    ? asyncOf(sql)
        .write(statement, params)
        .pipe(Effect.mapError((cause) => statementFailure(migration, cause)))
    : Effect.try({
        try: () => {
          sql.run(statement, params);
        },
        catch: (cause) => statementFailure(migration, { message: describeCause(cause) }),
      });

const readSearchPath = (sql: SqlExecutor): Effect.Effect<string | undefined, MigrationError> =>
  Effect.map(
    isAsync(sql)
      ? asyncOf(sql)
          .get<{ search_path: string }>("SHOW search_path")
          .pipe(
            Effect.mapError(
              (cause) =>
                new MigrationError({
                  message: `could not read search_path: ${cause.message}`,
                  cause,
                }),
            ),
          )
      : Effect.try({
          try: () => sql.get<{ search_path: string }>("SHOW search_path"),
          catch: (cause) =>
            new MigrationError({
              message: `could not read search_path: ${describeCause(cause)}`,
              cause,
            }),
        }),
    (row) => row?.search_path,
  );

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

/**
 * Whether a driver's failure is the registry's table (or the legacy `name`
 * column) not existing yet. Every link is read, because the wrapper's message
 * is generic; a permission or connection failure matches none of them and must
 * surface.
 */
const recoverable = (cause: unknown): boolean => {
  const message = causeDescriptions(cause).join(" ").toLowerCase();

  return (
    message.includes("no such table") ||
    message.includes("no such column") ||
    message.includes("undefined table") ||
    message.includes("undefined column") ||
    message.includes("unknown table") ||
    message.includes("unknown column") ||
    message.includes("does not exist") ||
    message.includes("doesn't exist")
  );
};

const readNames = (
  sql: SqlExecutor,
  statement: string,
): Effect.Effect<ReadonlyArray<string>, MigrationError> =>
  isAsync(sql)
    ? asyncOf(sql)
        .query<{ name: string }>(statement)
        .pipe(
          Effect.map((rows) => rows.map((row) => row.name)),
          Effect.mapError(
            (cause) =>
              new MigrationError({
                message: `could not read the applied migrations: ${describeCause(cause)}`,
                cause,
              }),
          ),
        )
    : Effect.try({
        try: () => sql.all<{ name: string }>(statement).map((row) => row.name),
        catch: (cause) =>
          new MigrationError({
            message: `could not read the applied migrations: ${describeCause(cause)}`,
            cause,
          }),
      });

/**
 * The migration names a target records as applied. A missing bookkeeping table
 * is a fresh database; a permission or connection failure is not, and must
 * surface, or a migration run would replay over a database it cannot read.
 */
const readAppliedNames = (
  sql: SqlExecutor,
  scope: Required<MigrationScope>,
): Effect.Effect<ReadonlyArray<string>, MigrationApplyError> => {
  const table = tableName(scope.table, scope);

  return Effect.gen(function* () {
    const primary = yield* readNames(sql, `SELECT name FROM ${table} ORDER BY name ASC`).pipe(
      Effect.result,
    );

    if (Result.isSuccess(primary)) return primary.success;

    if (!recoverable(primary.failure)) return yield* primary.failure;

    // The oldest Alchemy shape carries the name in `id`, so read that too —
    // otherwise a legacy upgrade would look like a fresh application.
    const legacy = yield* readNames(sql, `SELECT id AS name FROM ${table} ORDER BY id ASC`).pipe(
      Effect.result,
    );

    if (Result.isSuccess(legacy)) return legacy.success;

    if (!recoverable(legacy.failure)) return yield* legacy.failure;

    return [];
  });
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
  const before = new Set(yield* readAppliedNames(sql, scope));
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

  return (yield* readAppliedNames(sql, scope)).filter((name) => !before.has(name));
});

/**
 * Apply every pending migration, then converge the shipped description against
 * the target. This is what a deploy runs: the files are the baseline a reviewer
 * read, and the convergence is the additive delta between the description and
 * what the database actually has.
 *
 * A redeploy over an up-to-date target applies nothing and adds nothing.
 *
 * @primitive
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { sync } from "@potion.run/paykit"
 *
 * const result = yield* sync(sql, { schema: "billing" })
 * console.log(result.applied, result.columns)
 * ```
 */
export const sync = Effect.fn("Paykit.sync")(function* (sql: SqlExecutor, input?: MigrateOptions) {
  const applied = yield* migrate(sql, input);

  const converged = yield* converge(
    sql,
    input?.schema === undefined ? {} : { schema: input.schema },
  );

  return { applied, ...converged };
});

export { converge, type ConvergeOptions, type ConvergeResult } from "./Converge.ts";

export {
  MigrationError,
  MigrationHistoryConflictError,
  RewrittenMigrationHistoryError,
} from "@alchemy.run/sql/Migrations";

export type { MigrationApplyError, MigrationRecord } from "@alchemy.run/sql/Migrations";
