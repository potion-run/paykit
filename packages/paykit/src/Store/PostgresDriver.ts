import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { SqlError, type SqlExecutor, type SqlValue } from "./Sql.ts";
import { sqlClientExecutor } from "./SqlClientDriver.ts";

/**
 * Rewrite paykit's `?` placeholders to Postgres's `$1..$n`.
 *
 * The store statements are dialect-neutral, so the driver owns the placeholder
 * shape: `@effect/sql-pg` binds `$n`, while SQLite and D1 bind `?`. Quoted
 * strings, quoted identifiers and dollar-quoted bodies are left alone.
 *
 * @primitive
 */
export const toPostgresPlaceholders = (statement: string): string => {
  let next = 1;
  let output = "";
  let quote: "'" | '"' | null = null;
  let dollar: string | null = null;

  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]!;

    if (dollar !== null) {
      if (statement.startsWith(dollar, index)) {
        output += dollar;
        index += dollar.length - 1;
        dollar = null;
      } else {
        output += char;
      }

      continue;
    }

    if (quote !== null) {
      output += char;

      if (char === quote) quote = null;

      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      output += char;

      continue;
    }

    if (char === "$") {
      // `$$` or `$tag$`; a positional `$1` is not a dollar quote.
      const match = /^(\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(statement.slice(index));

      if (match !== null) {
        dollar = match[0];
        output += dollar;
        index += dollar.length - 1;

        continue;
      }
    }

    if (char === "?") {
      output += `$${next++}`;

      continue;
    }

    output += char;
  }

  return output;
};

/** A message from an error this boundary does not own, without assuming a class. */
const describe = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String(cause.message)
    : String(cause);

/** A failed statement, as paykit's port describes it. */
const failure = (statement: string, cause: unknown) =>
  new SqlError({ message: describe(cause), statement, cause });

/**
 * A `SqlExecutor` over an `@effect/sql-pg` client.
 *
 * Alchemy's `@alchemy.run/sql/Postgres` builds the client from a connection
 * string — in a Worker, the string `Cloudflare.Hyperdrive.Connect` yields, so
 * the pool is memoized per execution and Hyperdrive owns the pooling. This
 * adapter changes only the shape paykit's stores call (`query`, `write`,
 * `batch`, `atomic`) and the placeholder dialect; the connection, the pool and
 * the transaction control are the packages' own.
 *
 * The synchronous half refuses rather than block: a remote target has no
 * synchronous surface, and a store reaches Postgres only through
 * `SqlAsyncExecutor`.
 *
 * ### Hosting the model on Postgres
 * **Example:** Hyperdrive, `@effect/sql-pg` and the paykit world
 * ```typescript
 * const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(Connection);
 * const client = yield* SQL.Postgres({ url: hyperdrive.connectionString });
 * const sql = Paykit.postgresExecutor(client);
 *
 * const log = Paykit.SqlEventLog(sql, { now, schema: "billing" });
 * const { platform } = Paykit.SqlPlatform(sql, log, { now, schema: "billing" });
 * const World = Paykit.world({
 *   catalog,
 *   platform: Layer.succeed(Domain.Platform, platform),
 *   readStore: Paykit.SqlBillingReadStore(log),
 *   guards,
 * });
 * ```
 *
 * @primitive
 */
export const postgresExecutor = (client: SqlClient.SqlClient): SqlExecutor =>
  sqlClientExecutor(client, "postgres");

// ── a raw `pg` pool ─────────────────────────────────────────────────────────
//
// The same port over a `pg.Pool` a caller already owns — the client a Drizzle
// instance holds, or one an application opened itself. Kept structural so `pg`
// stays an optional peer and this module never imports it.

/** One row of a `pg` result, as the driver hands it back. */
export interface PgResultLike {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/** The query surface a pooled client has. */
export interface PgQueryableLike {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<PgResultLike>;
}

/** A checked-out client, released when its unit settles. */
export interface PgClientLike extends PgQueryableLike {
  release(): void;
}

/** A `pg.Pool`-shaped pool: query directly, or check out a client. */
export interface PgPoolLike extends PgQueryableLike {
  connect(): Promise<PgClientLike>;
}

/**
 * The connection an open `atomic` unit is using. A `Context` reference because
 * one pool serves many fibers: a statement from another fiber must go to the
 * pool, never join this unit's transaction.
 */
const InClient = Context.Reference<PgQueryableLike | undefined>("paykit/PostgresDriver/InClient", {
  defaultValue: () => undefined,
});

/**
 * A `SqlExecutor` over a raw `pg` pool.
 *
 * `atomic` checks out one client for the unit and routes every statement the
 * unit issues through it, so a read sees the writes before the commit — the
 * isolation `postgresExecutor` gets from `@effect/sql-pg`'s `withTransaction`,
 * without that dependency.
 *
 * ### A pool you already hold
 * **Example:** An existing `pg.Pool`
 * ```typescript
 * const sql = Paykit.pgPoolExecutor(pool);
 * yield* sql.atomic(Effect.gen(function* () {
 *   yield* sql.write("UPDATE billing_state SET version = ? WHERE account = ?", [2, account]);
 * }));
 * ```
 *
 * @primitive
 */
export const pgPoolExecutor = (pool: PgPoolLike): SqlExecutor => {
  const run = (target: PgQueryableLike, statement: string, params: ReadonlyArray<SqlValue>) =>
    Effect.tryPromise({
      try: async () => {
        const result = await target.query(toPostgresPlaceholders(statement), params);

        return result.rows;
      },
      catch: (cause) => failure(statement, cause),
    });

  const query = <A = Record<string, unknown>>(
    statement: string,
    params: ReadonlyArray<SqlValue> = [],
  ): Effect.Effect<ReadonlyArray<A>, SqlError> =>
    Effect.flatMap(Effect.service(InClient), (client) =>
      Effect.map(
        run(client ?? pool, statement, params),
        // SAFETY: pg types rows as objects; the statement decides the shape and each store decodes its own row.
        (rows) => rows as ReadonlyArray<A>,
      ),
    );

  const checkedOut = Effect.acquireRelease(
    Effect.tryPromise({
      try: () => pool.connect(),
      catch: (cause) => failure("connect", cause),
    }),
    (client) => Effect.sync(() => client.release()),
  );

  const refuse = (method: string) => (): never => {
    throw new Error(
      `Postgres has no synchronous ${method}. Its port is asynchronous: a store reaches it ` +
        `through SqlAsyncExecutor (query / write / batch / atomic), never the synchronous half.`,
    );
  };

  return {
    dialect: "postgres",
    run: refuse("run"),
    exec: refuse("exec"),
    get: refuse("get"),
    all: refuse("all"),
    transaction: refuse("transaction"),
    lock: () => {},
    query,
    write: (statement: string, params: ReadonlyArray<SqlValue> = []) =>
      Effect.asVoid(query(statement, params)),
    batch: (statements) =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* checkedOut;
          yield* Effect.tryPromise({
            try: () => client.query("BEGIN"),
            catch: (cause) => failure("BEGIN", cause),
          });

          const outcome = yield* Effect.exit(
            Effect.forEach(statements, (statement) =>
              Effect.provideService(run(client, statement, []), InClient, client),
            ),
          );

          if (outcome._tag === "Failure") {
            yield* Effect.orElseSucceed(
              Effect.tryPromise({
                try: () => client.query("ROLLBACK"),
                catch: (cause) => failure("ROLLBACK", cause),
              }),
              () => undefined,
            );

            return yield* Effect.failCause(outcome.cause);
          }

          yield* Effect.tryPromise({
            try: () => client.query("COMMIT"),
            catch: (cause) => failure("COMMIT", cause),
          });

          return outcome.value;
        }),
      ).pipe(Effect.asVoid),
    atomic: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* checkedOut;
          yield* Effect.tryPromise({
            try: () => client.query("BEGIN"),
            catch: (cause) => failure("BEGIN", cause),
          });

          const outcome = yield* Effect.exit(Effect.provideService(effect, InClient, client));

          if (outcome._tag === "Failure") {
            yield* Effect.orElseSucceed(
              Effect.tryPromise({
                try: () => client.query("ROLLBACK"),
                catch: (cause) => failure("ROLLBACK", cause),
              }),
              () => undefined,
            );

            return yield* Effect.failCause(outcome.cause);
          }

          yield* Effect.tryPromise({
            try: () => client.query("COMMIT"),
            catch: (cause) => failure("COMMIT", cause),
          });

          return outcome.value;
        }),
      ),
    isolation: "serializable",
  };
};
