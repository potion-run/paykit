import { Database } from "bun:sqlite";
import type { SqlExecutor } from "../../src/Store/Sql.ts";
import { fromDatabase } from "../../src/Store/SqliteDriver.ts";

/**
 * A Bun SQLite executor for the store tests: the shipped driver, so a test
 * exercises exactly what a deployment does — the asynchronous port, its
 * `atomic` unit and `BEGIN IMMEDIATE`'s single writer.
 */
export const sqliteExecutor = (database: Database = new Database(":memory:")): SqlExecutor =>
  fromDatabase(database);
