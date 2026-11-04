import { Database } from "bun:sqlite";
import type { SqlExecutor, SqlValue } from "../../src/Store/Sql.ts";

const transaction = <A>(database: Database, f: () => A): A => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = f();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

/**
 * A Bun SQLite executor for the store tests. Production drivers implement the
 * same port; `batch` mirrors D1's atomic batch, and `transaction` mirrors
 * `BEGIN IMMEDIATE`'s single writer.
 */
export const sqliteExecutor = (database: Database = new Database(":memory:")): SqlExecutor => ({
  dialect: "sqlite",
  run: (sql: string, params: ReadonlyArray<SqlValue> = []) => {
    database.query(sql).run(...params);
  },
  exec: (sql: string) => {
    database.exec(sql);
  },
  batch: (statements: ReadonlyArray<string>) => {
    transaction(database, () => {
      for (const statement of statements) database.exec(statement);
    });
  },
  get: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
    (database.query(sql).get(...params) ?? undefined) as A | undefined,
  all: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
    database.query(sql).all(...params) as A[],
  transaction: <A>(f: () => A) => transaction(database, f),
  lock: () => {
    // BEGIN IMMEDIATE serializes SQLite writers for the whole transaction.
  },
});
