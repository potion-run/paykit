import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * The dialect a `SqlExecutor` speaks. Migrations render their DDL per dialect
 * and the store quotes identifiers the same way on both.
 */
export type SqlDialect = "sqlite" | "postgres" | "mysql";

/** A value one statement can bind. */
export type SqlValue = string | number | null;

/**
 * A statement failed. Serialized as a tagged error so a caller can match it by
 * tag rather than by message, and carrying the statement for an operator.
 */
export class SqlError extends Data.TaggedError("SqlError")<{
  readonly message: string;
  /** The statement that failed, or the batch's size when it is a batch. */
  readonly statement: string;
  readonly cause?: unknown;
}> {}

/**
 * The async half of the executor port: the shape Alchemy's own SQL adapters
 * implement, so a target that can only be reached asynchronously — D1 over
 * HTTP, a `pg` client, a `mysql2` connection — is a driver rather than a
 * rewrite of the store.
 *
 * Kept 1:1 with Alchemy's `SqlExecutor` (`query` returning rows, `batch`
 * running statements as one atomic unit) so a driver written for one is a
 * driver for the other.
 * Source: https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.85/packages/sql/src/Migrations/Format.ts
 */
export interface SqlAsyncExecutor {
  readonly dialect: SqlDialect;
  /**
   * Run one query and return its rows as objects. `params` bind as `?`
   * placeholders; a driver with no native parameter support inlines them.
   */
  readonly query: <A = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ) => Effect.Effect<ReadonlyArray<A>, SqlError>;
  /**
   * Run one statement that writes. Inside an `atomic` unit its effect is
   * deferred to the unit's commit on a target without an interactive
   * transaction, so a store states the write and the driver decides when it
   * lands — the same contract `batch` has, for one parameterized statement.
   */
  readonly write: (sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<void, SqlError>;
  /**
   * Execute statements as one atomic unit: a transaction where the target has
   * one, and a single batched call where it does not (D1 over HTTP). A driver
   * with no native parameter support inlines them as SQL literals, which is
   * how Alchemy's own `batch` works.
   */
  readonly batch: (statements: ReadonlyArray<string>) => Effect.Effect<void, SqlError>;
  /**
   * Run `effect` as one atomic unit: every `batch` it performs commits
   * together, and a failure rolls all of them back.
   *
   * This is where the two kinds of target differ, and both answers are right:
   * a database with an interactive transaction holds one open across the
   * effect's reads and writes; a target that only has an atomic multi-statement
   * call collects the effect's writes and commits them at the end. A store
   * therefore states *what* belongs together and the driver decides *how*.
   *
   * A target with no isolation between the reads and the commit (D1 over HTTP)
   * says so in `isolation`, so a store that needs it can refuse rather than
   * assume.
   */
  readonly atomic: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
  /**
   * `serializable` when a transaction isolates its reads from other writers,
   * `deferred` when the writes commit together but the reads did not hold a
   * lock. Only D1 is `deferred`.
   */
  readonly isolation: "serializable" | "deferred";
}

/**
 * The synchronous surface the stores use today: it reflects what SQLite gives a
 * single process, where a statement's answer is available before the next line
 * runs, `transaction` is `BEGIN IMMEDIATE`, and `lock` is a no-op because that
 * transaction already holds the writer's lock.
 *
 * An asynchronous target cannot implement this half, which is why the port has
 * two: a driver implements whichever its target allows, and the store is
 * converted from here to {@link SqlAsyncExecutor} one consumer at a time.
 */
export interface SqlSyncExecutor {
  /** Execute one statement with positional parameters. */
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => void;
  /** Execute a multi-statement script (DDL). */
  readonly exec: (sql: string) => void;
  readonly get: <A>(sql: string, params?: ReadonlyArray<SqlValue>) => A | undefined;
  readonly all: <A>(sql: string, params?: ReadonlyArray<SqlValue>) => ReadonlyArray<A>;
  /** Run `f` in one transaction, rolling back if it throws. */
  readonly transaction: <A>(f: () => A) => A;
  /** Take the per-account write lock for the current transaction. */
  readonly lock: (account: string) => void;
}

/**
 * A SQL target. `dialect` selects the DDL and the identifier quoting; the rest
 * is whichever access the target allows.
 *
 * A synchronous driver implements {@link SqlSyncExecutor} (and should also
 * implement {@link SqlAsyncExecutor} once a store calls it); an asynchronous
 * driver implements only {@link SqlAsyncExecutor}, and its synchronous methods
 * refuse rather than block.
 */
export type SqlExecutor = SqlSyncExecutor &
  Partial<SqlAsyncExecutor> & {
    readonly dialect: SqlDialect;
  };

const unsupported = (sql: SqlExecutor, what: string): SqlError =>
  new SqlError({
    message: `${sql.dialect} driver has not implemented the asynchronous ${what}; see SqlAsyncExecutor`,
    statement: "",
  });

/**
 * Narrow an executor to its asynchronous half, or say why it cannot. A driver
 * that has not converted yet fails every call with a `SqlError` naming the
 * method, rather than falling back to a synchronous path that a remote target
 * does not have.
 */
/** The asynchronous port, plus the one-row read a store keeps needing. */
export type SqlAsync = SqlAsyncExecutor & {
  /** The first row, or `undefined`. A store reads one instance, not a page. */
  readonly get: <A = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ) => Effect.Effect<A | undefined, SqlError>;
};

export const asyncOf = (sql: SqlExecutor): SqlAsync => {
  // A driver that declares an asynchronous half is used as it is. A driver that
  // only has the synchronous one — a test fake, or a single-process target — is
  // lifted into the asynchronous shape, so a store is written once against the
  // asynchronous port and still runs on the simplest engine.
  if (sql.query !== undefined) {
    const query = sql.query;

    // SAFETY: the executor's generic row type is erased at the SQL boundary; the caller decodes it, and a fallback method refuses rather than returns a row.
    return {
      dialect: sql.dialect,
      query,
      get: (statement, params) =>
        Effect.map(
          query(statement, params) as Effect.Effect<
            ReadonlyArray<Record<string, unknown>>,
            SqlError
          >,
          (rows) => rows[0],
        ) as never,
      write: sql.write ?? ((statement, params) => Effect.asVoid(query(statement, params))),
      batch: sql.batch ?? ((() => Effect.fail(unsupported(sql, "batch"))) as never),
      atomic: sql.atomic ?? ((effect) => effect as never),
      isolation: sql.isolation ?? "serializable",
    };
  }

  // SAFETY: the executor's generic row type is erased at the SQL boundary; the
  // caller decodes it, and the row is exactly what the statement selected.
  return {
    dialect: sql.dialect,
    query: <A>(statement: string, params: ReadonlyArray<SqlValue> = []) =>
      Effect.sync(() => sql.all<A>(statement, params) as ReadonlyArray<A>),
    get: <A>(statement: string, params: ReadonlyArray<SqlValue> = []) =>
      Effect.sync(() => sql.get<A>(statement, params)) as never,
    write: (statement, params) =>
      Effect.sync(() => {
        sql.run(statement, params);
      }),
    batch: (statements) =>
      Effect.sync(() => {
        sql.transaction(() => {
          for (const statement of statements) sql.exec(statement);
        });
      }),
    // A synchronous driver's own `transaction` is the atomic unit; running the
    // effect inside it is not possible from here, so the statements land as
    // they are written. A target that needs real atomicity supplies `atomic`.
    atomic: (effect) => effect as never,
    isolation: "serializable",
  };
};
