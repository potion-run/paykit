import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { SqlAsync, SqlError, SqlExecutor, SqlValue } from "./Sql.ts";

/** A prepared statement, as D1's `batch` accepts it. */
export interface D1Prepared {
  /** The statement this handle will run, so a test can read it back. */
  readonly sql?: string;
  all<T = Record<string, unknown>>(): Promise<{ results?: ReadonlyArray<T> }>;
}

/** The slice of a D1 binding this driver uses. */
export interface D1Like {
  prepare(sql: string): D1Prepared & {
    bind(...values: ReadonlyArray<SqlValue>): D1Prepared;
  };
  batch(statements: ReadonlyArray<D1Prepared>): Promise<unknown>;
}

const fail = (statement: string, cause: unknown): SqlError =>
  ({
    _tag: "SqlError",
    message: String((cause as { message?: unknown })?.message ?? cause),
    statement,
    cause,
  }) as SqlError;

const refused = (what: string): never => {
  throw new Error(
    `D1 has no synchronous ${what}. Its port is asynchronous: a store reaches it through ` +
      `SqlAsyncExecutor (query / get / write / batch / atomic), never through the synchronous half.`,
  );
};

/** One write a unit will commit. */
interface BufferedWrite {
  readonly sql: string;
  readonly params: ReadonlyArray<SqlValue>;
}

/**
 * The writes a fiber's open unit has collected, or `undefined` outside one.
 * A `Context` reference rather than a module variable because D1 has one
 * writer but a Worker can serve many requests: a write from another fiber must
 * commit on its own, never join this unit's batch.
 */
const InUnit = Context.Reference<Array<BufferedWrite> | undefined>("paykit/D1/InUnit", {
  defaultValue: () => undefined,
});

/**
 * A `SqlExecutor` over Cloudflare's D1, implementing the asynchronous half of
 * the port that Alchemy's D1 executor implements
 * (`@alchemy.run/cloudflare/D1/ApplyMigrations`, `makeD1MigrationExecutor`):
 * `query`/`get` for reads, `write`/`batch` for writes, and `atomic` for a unit.
 *
 * D1 has no interactive transaction and no isolation between a read and a
 * commit, so `atomic` collects the unit's writes and commits them in **one**
 * `batch` call — the closest thing the platform offers, and what Alchemy's own
 * driver does for D1. `isolation` says `"deferred"` so a store that needs more
 * can refuse rather than assume.
 *
 * The synchronous half refuses with an error naming the constraint rather than
 * blocking a request thread that cannot block.
 *
 * ### Reaching D1 from a Worker
 * **Example:** One atomic unit
 * ```typescript
 * const sql = Paykit.d1Executor(env.BILLING);
 * yield* sql.atomic(
 *   Effect.gen(function* () {
 *     yield* sql.write("INSERT INTO billing_event (…) VALUES (?, ?, …)", [...]);
 *     yield* sql.write("INSERT INTO billing_state (…) VALUES (?, ?, ?)", [...]);
 *   }),
 * );
 * ```
 *
 * @primitive
 */
export const d1Executor = (d1: D1Like): SqlExecutor => {
  const prepared = (write: BufferedWrite): D1Prepared =>
    write.params.length === 0 ? d1.prepare(write.sql) : d1.prepare(write.sql).bind(...write.params);

  const commit = (writes: ReadonlyArray<BufferedWrite>) =>
    writes.length === 0
      ? Effect.void
      : Effect.tryPromise({
          try: () => d1.batch(writes.map(prepared)).then(() => undefined),
          catch: (cause) => fail(`${writes.length} statements`, cause),
        });

  const read = <A>(sql: string, params: ReadonlyArray<SqlValue>) =>
    Effect.tryPromise({
      try: () => {
        const statement = params.length === 0 ? d1.prepare(sql) : d1.prepare(sql).bind(...params);
        return statement.all<A>().then((result) => result.results ?? []);
      },
      catch: (cause) => fail(sql, cause),
    });

  const async: SqlAsync = {
    dialect: "sqlite",
    isolation: "deferred",

    atomic: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.service(InUnit), (current) =>
        current !== undefined
          ? Effect.die("D1 atomic unit is not re-entrant")
          : Effect.gen(function* () {
              const writes: Array<BufferedWrite> = [];
              const outcome = yield* Effect.exit(Effect.provideService(effect, InUnit, writes));
              if (outcome._tag === "Failure") {
                // Nothing commits: the failed unit's writes are dropped.
                return yield* Effect.failCause(outcome.cause);
              }
              yield* commit(writes);
              return outcome.value;
            }),
      ),

    query: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) => read<A>(sql, params),

    get: <A>(sql: string, params: ReadonlyArray<SqlValue> = []) =>
      Effect.map(read<A>(sql, params), (rows) => rows[0]),

    write: (sql: string, params: ReadonlyArray<SqlValue> = []) =>
      Effect.flatMap(Effect.service(InUnit), (writes) =>
        writes === undefined
          ? commit([{ sql, params }])
          : Effect.sync(() => {
              writes.push({ sql, params });
            }),
      ),

    batch: (statements: ReadonlyArray<string>) =>
      Effect.flatMap(Effect.service(InUnit), (writes) =>
        writes === undefined
          ? commit(statements.map((sql) => ({ sql, params: [] })))
          : Effect.sync(() => {
              for (const sql of statements) writes.push({ sql, params: [] });
            }),
      ),
  };

  return {
    ...async,
    dialect: "sqlite",
    run: () => refused("run"),
    exec: () => refused("exec"),
    get: () => refused("get"),
    all: () => refused("all"),
    transaction: () => refused("transaction"),
    lock: () => {},
  } as unknown as SqlExecutor;
};
