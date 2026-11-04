import { Database } from "bun:sqlite";
import type { SqlExecutor, SqlValue } from "../../src/Store/Sql.ts";

/** A Bun SQLite executor for the store tests. Production drivers implement the same port. */
export const sqliteExecutor = (database: Database = new Database(":memory:")): SqlExecutor => ({
  run: (sql: string, params: ReadonlyArray<SqlValue> = []) => {
    database.query(sql).run(...params);
  },
  exec: (sql: string) => {
    database.exec(sql);
  },
  get: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
    (database.query(sql).get(...params) ?? undefined) as A | undefined,
  all: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
    database.query(sql).all(...params) as A[],
  transaction: <A>(f: () => A): A => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = f();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
  lock: () => {
    // BEGIN IMMEDIATE serializes SQLite writers for the whole transaction.
  },
});
