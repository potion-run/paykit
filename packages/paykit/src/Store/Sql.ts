/** A SQL value a statement can bind. */
export type SqlValue = string | number | null;

// `dialect`, `batch` and `transaction` mirror Alchemy's migration executor
// contract, credited in ../Migrations/index.ts. Alchemy's `query` returns an
// Effect; paykit's store is synchronous, so its adapter lifts this port into
// it via Effect.try.
// Source: https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.85/packages/sql/src/Migrations/Format.ts

/**
 * The dialect a `SqlExecutor` speaks. Migrations render their DDL per dialect
 * and the store quotes identifiers the same way on both.
 */
export type SqlDialect = "sqlite" | "postgres";

/**
 * The small surface the store needs. A driver adapter implements it for
 * Postgres, D1/SQLite or libSQL; the store itself stays dialect-agnostic.
 *
 * The shape mirrors `@alchemy.run/sql`'s migration executor: `dialect` selects
 * the DDL, `batch` is the atomic unit a target without transactions over HTTP
 * (D1) can offer, and `transaction` is the one SQLite and Postgres use.
 *
 * Parameters use `?` placeholders. A Postgres adapter translates them to `$n`
 * (or binds them natively) before reaching the driver.
 */
export interface SqlExecutor {
  /** The dialect this executor speaks. */
  readonly dialect: SqlDialect;
  /** Execute one statement with positional parameters. */
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => void;
  /** Execute a multi-statement script (DDL). */
  readonly exec: (sql: string) => void;
  readonly get: <A>(sql: string, params?: ReadonlyArray<SqlValue>) => A | undefined;
  readonly all: <A>(sql: string, params?: ReadonlyArray<SqlValue>) => ReadonlyArray<A>;
  /** Run `f` in one transaction, rolling back if it throws. */
  readonly transaction: <A>(f: () => A) => A;
  /**
   * Execute statements as one atomic unit. A target without transactions over
   * HTTP (D1) supplies this; executors that can leave it undefined use
   * `transaction` instead. When supplied it must be atomic — migrations record
   * bookkeeping in the same unit as their DDL.
   */
  readonly batch?: (statements: ReadonlyArray<string>) => void;
  /** Take the per-account write lock for the current transaction. */
  readonly lock: (account: string) => void;
}
