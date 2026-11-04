import { Database } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { SqlAsync, SqlError, SqlExecutor, SqlValue } from "./Sql.ts";

/** What a synchronous driver needs to open a database. */
export interface SqliteDriverOptions {
  /**
   * The file to open, or `:memory:` for a database that lives as long as the
   * process. A file is what makes a store survive a restart.
   */
  readonly filename?: string;
  /** Open the database for reading only. */
  readonly readonly?: boolean;
}

/** Close a driver's database. The caller owns the handle, so this is explicit. */
export interface ClosableSqlExecutor extends SqlExecutor {
  readonly close: () => void;
}

const fail = (statement: string, cause: unknown): SqlError =>
  ({
    _tag: "SqlError",
    message: `${String((cause as { message?: unknown })?.message ?? cause)}`,
    statement,
    cause,
  }) as SqlError;

/**
 * A `SqlExecutor` over Bun's synchronous SQLite driver: the durable store for a
 * single process — a Bun server, a script, a test, or a `SqlPlatform` host that
 * is not a Worker.
 *
 * `transaction` is `BEGIN IMMEDIATE`, SQLite's one-writer lock for the whole
 * transaction, so `lock` is a no-op: a store can take an account's lock
 * without a second mechanism. `batch` is one transaction, because SQLite can
 * do better than a target that only has an atomic multi-statement call.
 *
 * Both halves of the port are implemented: the synchronous surface the stores
 * use today, and Alchemy's asynchronous `query`/`batch` shape so this driver
 * and a remote one are interchangeable to a converted store.
 *
 * Every statement uses `?` placeholders, which SQLite binds natively.
 *
 * ### Hosting paykit in one process
 * **Example:** A durable model on a file
 * ```typescript
 * const sql = Paykit.SqliteDriver({ filename: "billing.db" });
 * yield* Paykit.migrate(sql);
 * const log = Paykit.SqlEventLog(sql, { now: () => Date.now() });
 * const { platform } = Paykit.SqlPlatform(sql, log, { now: () => Date.now() });
 * ```
 *
 * @primitive
 */
export const SqliteDriver = (options: SqliteDriverOptions = {}): ClosableSqlExecutor => {
  const database = new Database(
    options.filename ?? ":memory:",
    options.readonly === undefined ? undefined : { readonly: options.readonly },
  );
  return fromDatabase(database);
};

/**
 * Wrap a database handle a caller already owns — `new Database(...)`, or the
 * one a test opened.
 *
 * @primitive
 */
export const fromDatabase = (database: Database): ClosableSqlExecutor => {
  const transaction = <A>(f: () => A): A => {
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

  // One writer at a time: `BEGIN IMMEDIATE` is not re-entrant, and the
  // executor is shared, so a semaphore keeps two transactions from interleaving
  // their BEGIN/COMMIT on the same handle. `depth` says whether a statement is
  // already inside a unit, so a batch joins it rather than opening a second.
  const writer = Semaphore.makeUnsafe(1);
  let depth = 0;

  const async: SqlAsync = {
    dialect: "sqlite",
    isolation: "serializable",
    atomic: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      writer.withPermits(1)(
        Effect.acquireUseRelease(
          Effect.try({
            try: () => database.exec("BEGIN IMMEDIATE"),
            catch: (cause) => fail("BEGIN IMMEDIATE", cause),
          }),
          () =>
            Effect.suspend(() => {
              depth += 1;
              return effect.pipe(Effect.ensuring(Effect.sync(() => (depth -= 1))));
            }),
          (_, exit) =>
            Effect.sync(() => {
              // A failed effect rolls back; a successful one commits. Both
              // release the writer's lock, which is the whole point of the
              // acquire/release pair.
              database.exec(exit._tag === "Success" ? "COMMIT" : "ROLLBACK");
            }),
        ),
      ),

    query: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
      Effect.try({
        try: () => database.query(sql).all(...params) as ReadonlyArray<A>,
        catch: (cause) => fail(sql, cause),
      }),
    get: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
      Effect.try({
        try: () => (database.query(sql).get(...params) ?? undefined) as A | undefined,
        catch: (cause) => fail(sql, cause),
      }),
    // Outside a unit this is a single statement; inside one it belongs to that
    // unit's transaction, and the store does not need to know which.
    write: (sql: string, params: ReadonlyArray<SqlValue> = []) =>
      Effect.try({
        try: () => {
          database.query(sql).run(...params);
        },
        catch: (cause) => fail(sql, cause),
      }),
    batch: (statements: ReadonlyArray<string>) =>
      Effect.try({
        try: () => {
          // Inside a unit the transaction is already open; outside one, this
          // batch is itself the atomic unit.
          const run = () => {
            for (const statement of statements) database.exec(statement);
          };
          if (depth > 0) run();
          else transaction(run);
        },
        catch: (cause) => fail(`${statements.length} statements`, cause),
      }),
  };

  return {
    ...async,
    dialect: "sqlite",
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
    transaction,
    lock: () => {},
    close: () => database.close(),
  };
};
