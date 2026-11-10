import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { toPostgresPlaceholders } from "./PostgresDriver.ts";
import { SqlError, type SqlExecutor, type SqlValue } from "./Sql.ts";

/** A message from an error this boundary does not own, without assuming a class. */
const describe = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String(cause.message)
    : String(cause);

/** A failed statement, as paykit's port describes it. */
const failure = (statement: string, cause: unknown) =>
  new SqlError({ message: describe(cause), statement, cause });

/**
 * A `SqlExecutor` over an `@effect/sql` client — the shape Alchemy's
 * `@alchemy.run/sql/Postgres` and `@alchemy.run/sql/MySQL` build.
 *
 * Both clients implement the generic `SqlClient`, so the only difference is the
 * placeholder dialect: Postgres binds `$n`, MySQL and SQLite bind `?`. The
 * adapter therefore mirrors `postgresExecutor` 1:1 and only rewrites for
 * Postgres — the connection, pooling and transaction control stay the
 * packages' own.
 *
 * The synchronous half refuses rather than block: a remote target has no
 * synchronous surface, and a store reaches it only through `SqlAsyncExecutor`.
 */
export const sqlClientExecutor = (
  client: SqlClient.SqlClient,
  dialect: "postgres" | "mysql",
): SqlExecutor => {
  const rewrite =
    dialect === "postgres" ? toPostgresPlaceholders : (statement: string) => statement;

  const query = <A = Record<string, unknown>>(
    statement: string,
    params: ReadonlyArray<SqlValue> = [],
  ): Effect.Effect<ReadonlyArray<A>, SqlError> =>
    client
      .unsafe<A & object>(rewrite(statement), params)
      .pipe(Effect.mapError((cause) => failure(statement, cause)));

  const refuse = (method: string) => (): never => {
    throw new Error(
      `${dialect} has no synchronous ${method}. Its port is asynchronous: a store reaches it ` +
        `through SqlAsyncExecutor (query / write / batch / atomic), never the synchronous half.`,
    );
  };

  return {
    dialect,
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
        .withTransaction(
          Effect.forEach(statements, (statement) => client.unsafe(rewrite(statement))),
        )
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
