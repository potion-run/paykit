import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { SqlError, type SqlExecutor, type SqlValue } from "./Sql.ts";

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
export const postgresExecutor = (client: SqlClient.SqlClient): SqlExecutor => {
  const query = <A = Record<string, unknown>>(
    statement: string,
    params: ReadonlyArray<SqlValue> = [],
  ): Effect.Effect<ReadonlyArray<A>, SqlError> =>
    client
      .unsafe<A & object>(toPostgresPlaceholders(statement), params)
      .pipe(Effect.mapError((cause) => failure(statement, cause)));

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
      client
        .withTransaction(Effect.forEach(statements, (statement) => client.unsafe(statement)))
        .pipe(
          Effect.asVoid,
          Effect.catchTag("SqlError", (cause) => Effect.fail(failure("batch", cause))),
        ),
    atomic: (effect) =>
      client
        .withTransaction(effect)
        .pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failure("transaction", cause)))),
    isolation: "serializable",
  };
};
