/** A SQL value a statement can bind. */
export type SqlValue = string | number | null;

/**
 * The small surface the store needs. A driver adapter implements it for
 * Postgres, D1/SQLite or libSQL; the store itself stays dialect-agnostic.
 */
export interface SqlExecutor {
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
