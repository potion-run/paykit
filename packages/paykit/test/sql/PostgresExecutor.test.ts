import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { postgresExecutor, toPostgresPlaceholders } from "../../src/Store/PostgresDriver.ts";
import { asyncOf } from "../../src/Store/Sql.ts";

/**
 * The smallest client shape `postgresExecutor` uses: `unsafe` for one
 * statement and `withTransaction` for the atomic unit. A real client is
 * Alchemy's `@effect/sql-pg` client; this fake records what the adapter asked
 * for so the shape can be asserted without a Postgres.
 */
const fake = (rows: ReadonlyArray<Record<string, unknown>> = []) => {
  const calls: Array<{ readonly statement: string; readonly params: ReadonlyArray<unknown> }> = [];
  let transactions = 0;

  const client = {
    unsafe: (statement: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        calls.push({ statement, params });

        return rows;
      }),
    withTransaction: (effect: Effect.Effect<unknown, unknown, unknown>) =>
      Effect.sync(() => {
        transactions++;
      }).pipe(Effect.andThen(effect)),
  } as unknown as SqlClient.SqlClient;

  return { client, calls, transactions: () => transactions };
};

describe("the Postgres executor", () => {
  it("rewrites the store's ? placeholders to $n, in order", () => {
    expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("leaves quoted text, quoted identifiers and dollar-quoted bodies alone", () => {
    expect(
      toPostgresPlaceholders("SELECT 'a?b', \"c?d\", $$e?f$$, $tag$g?h$tag$ WHERE id = ?"),
    ).toBe("SELECT 'a?b', \"c?d\", $$e?f$$, $tag$g?h$tag$ WHERE id = $1");
  });

  it("keeps an escaped quote inside a string from opening a new one", () => {
    expect(toPostgresPlaceholders("SELECT 'it''s ?' WHERE id = ?")).toBe(
      "SELECT 'it''s ?' WHERE id = $1",
    );
  });

  it("answers a query with the client's rows and the translated statement", () =>
    Effect.gen(function* () {
      const { client, calls } = fake([{ n: 1 }]);
      const sql = asyncOf(postgresExecutor(client));

      const rows = yield* sql.query("SELECT ? AS n", [1]);

      expect(rows).toEqual([{ n: 1 }]);
      expect(calls).toEqual([{ statement: "SELECT $1 AS n", params: [1] }]);
    }));

  it("reads one row for get, and discards rows for write", () =>
    Effect.gen(function* () {
      const { client } = fake([{ n: 1 }]);
      const sql = asyncOf(postgresExecutor(client));

      expect(yield* sql.get("SELECT ? AS n", [1])).toEqual({ n: 1 });
      expect(yield* sql.write("UPDATE t SET n = ? WHERE id = ?", [1, 2])).toBe(undefined);
    }));

  it("runs a batch and an atomic unit through the client's transaction", () =>
    Effect.gen(function* () {
      const { client, transactions } = fake();
      const sql = asyncOf(postgresExecutor(client));

      yield* sql.batch(["CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)"]);

      const unit = yield* sql.atomic(Effect.succeed(42));

      expect(unit).toBe(42);
      expect(transactions()).toBe(2);
    }));

  it("maps an effect SQL error to paykit's SqlError", () =>
    Effect.gen(function* () {
      const failure = new SqlError.SqlError({
        message: "connection reset",
        cause: undefined,
        reason: new SqlError.ConnectionError({ cause: undefined }),
      } as never);

      const client = {
        unsafe: () => Effect.fail(failure),
        withTransaction: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      } as unknown as SqlClient.SqlClient;

      const error = yield* Effect.flip(asyncOf(postgresExecutor(client)).query("SELECT ?", [1]));

      expect(error._tag).toBe("SqlError");
      expect(error.message).toBe("connection reset");
      expect(error.statement).toBe("SELECT ?");
    }));
});
