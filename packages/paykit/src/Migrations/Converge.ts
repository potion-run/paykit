// Additive convergence of the shipped schema description against a live
// database. The doctrine is Alchemy's observe-then-ensure: read what the target
// actually has, compute the delta to the description, apply only the delta. The
// one thing it never does is generate a destructive statement — no DROP, no
// rename, no type change — because a billing table is the ledger (ADR 0049).
//
// Introspection is Alchemy's own `tableColumns`, the same cross-dialect helper
// its migration registry uses to classify foreign bookkeeping tables. Reusing
// it keeps the SQL (PRAGMA / information_schema) out of this package.
import {
  MigrationError,
  tableColumns,
  type MigrationApplyError,
  type SqlExecutor as MigrationSqlExecutor,
} from "@alchemy.run/sql/Migrations";
import * as Effect from "effect/Effect";
import { asyncOf, type SqlExecutor, type SqlValue } from "../Store/Sql.ts";
import { DEFAULT_SCHEMA, isSchemaName, tableName, type TableScope } from "../Store/Tables.ts";
import {
  BILLING_SCHEMA,
  columnStatement,
  indexStatement,
  indexesOf,
  tableStatement,
  tablesOf,
} from "./Schema.ts";

/** Which Postgres schema to converge. SQLite ignores it. */
export interface ConvergeOptions {
  readonly schema?: string;
}

/**
 * What one convergence changed. `extra` names columns the target has and the
 * description does not: they are reported, never dropped, because an operator
 * may still read them and a destructive change is a human decision.
 */
export interface ConvergeResult {
  /** Tables the description has and the target did not. */
  readonly created: ReadonlyArray<string>;
  /** `table.column` pairs added by `ALTER TABLE ... ADD COLUMN`. */
  readonly columns: ReadonlyArray<string>;
  /** Indexes ensured with `CREATE INDEX IF NOT EXISTS`. */
  readonly indexes: ReadonlyArray<string>;
  /** `table.column` pairs present in the target and absent from the description. */
  readonly extra: ReadonlyArray<string>;
}

/** The registry's bookkeeping binds are strings, numbers and null. */
const binds = (params: ReadonlyArray<unknown> | undefined): ReadonlyArray<SqlValue> =>
  // SAFETY: the values are migration bookkeeping (name, hash, timestamp), never a caller's object.
  (params ?? []) as ReadonlyArray<SqlValue>;

const introspectFailure = (cause: { readonly message: string }) =>
  new MigrationError({ message: `could not introspect the target: ${cause.message}`, cause });

const applyFailure = (statement: string, cause: { readonly message: string }) =>
  new MigrationError({
    message: `convergence statement failed: ${cause.message} (${statement})`,
    cause,
  });

/**
 * Adapt paykit's executor to the registry's introspection port. `tableColumns`
 * only calls `query`, but the interface asks for `batch` too, and a driver's
 * `batch` is the right place for a multi-statement convergence step.
 */
const inspectorOf = (sql: SqlExecutor, scope: TableScope): MigrationSqlExecutor => {
  const port = asyncOf(sql);

  return {
    dialect: scope.dialect,
    ...(scope.dialect === "postgres" ? { defaultSchema: scope.schema } : {}),
    transactionalDdl: true,
    query: (statement, params) =>
      port.query<Record<string, unknown>>(statement, binds(params)).pipe(
        Effect.map((rows) => [...rows]),
        Effect.mapError(introspectFailure),
      ),
    batch: (statements) => port.batch(statements).pipe(Effect.mapError(introspectFailure)),
  };
};

const run = (sql: SqlExecutor, statement: string): Effect.Effect<void, MigrationApplyError> =>
  asyncOf(sql)
    .batch([statement])
    .pipe(Effect.mapError((cause) => applyFailure(statement, cause)));

const addColumn = (
  table: string,
  column: { readonly name: string; readonly type: string; readonly primaryKey?: boolean },
  scope: TableScope,
): MigrationError =>
  new MigrationError({
    message:
      `${table}.${column.name}: the target lacks this column, and an additive convergence ` +
      `cannot ${column.type === "serial" || column.primaryKey === true ? "add a key column" : "add NOT NULL without a default"}. ` +
      `Append a migration file with the backfill instead ` +
      `(node packages/paykit/scripts/schema.ts ${scope.dialect} --file=<id> > migrations/<id>.sql). ` +
      `Postgres schema: ${scope.schema ?? "(none)"}`,
  });

/**
 * Converge the shipped description against the target, additively.
 *
 * Reads every table's columns once, then:
 * - creates a table the target lacks (the shipped migration normally did this);
 * - adds a column the description has and the target lacks, when the column is
 *   nullable, or `NOT NULL` with a default, and not a key;
 * - ensures every index with `CREATE INDEX IF NOT EXISTS`.
 *
 * It refuses — with a `MigrationError` naming the column — to add a primary key
 * or a `NOT NULL` column without a default: those need a backfill, which is a
 * committed migration file and a human's review, not a deploy-time guess.
 *
 * Idempotent: a second run against a converged target applies no DDL.
 *
 * @primitive
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { converge } from "@potion.run/paykit"
 *
 * const changed = yield* converge(sql, { schema: "billing" })
 * if (changed.columns.length > 0) console.log("added", changed.columns)
 * ```
 */
export const converge = Effect.fn("Paykit.converge")(function* (
  sql: SqlExecutor,
  options: ConvergeOptions = {},
) {
  const scope: TableScope = {
    dialect: sql.dialect,
    schema: options.schema ?? DEFAULT_SCHEMA,
  };

  if (scope.dialect === "postgres" && !isSchemaName(scope.schema ?? "")) {
    return yield* new MigrationError({
      message: `"${scope.schema}" is not a safe Postgres schema name; refusing to converge it`,
    });
  }

  const executor = inspectorOf(sql, scope);
  const created: string[] = [];
  const columns: string[] = [];
  const indexes: string[] = [];
  const extra: string[] = [];

  for (const table of tablesOf(BILLING_SCHEMA)) {
    const present = yield* tableColumns(executor, table.name, scope.schema);

    if (present.length === 0) {
      yield* run(sql, tableStatement(table, scope));
      created.push(table.name);
      continue;
    }

    const names = new Set(present.map((column) => column.name));

    for (const column of table.columns) {
      if (names.has(column.name)) continue;

      if (column.type === "serial" || column.primaryKey === true) {
        return yield* addColumn(table.name, column, scope);
      }

      if (column.notNull === true && column.default === undefined) {
        return yield* addColumn(table.name, column, scope);
      }

      yield* run(
        sql,
        `ALTER TABLE ${tableName(table.name, scope)} ADD COLUMN ${columnStatement(column, scope.dialect)}`,
      );
      columns.push(`${table.name}.${column.name}`);
    }

    for (const name of names) {
      if (!table.columns.some((column) => column.name === name)) {
        extra.push(`${table.name}.${name}`);
      }
    }
  }

  for (const index of indexesOf(BILLING_SCHEMA)) {
    yield* run(sql, indexStatement(index, scope));
    indexes.push(index.name);
  }

  return { created, columns, indexes, extra } satisfies ConvergeResult;
});
