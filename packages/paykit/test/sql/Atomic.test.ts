import { Database } from "bun:sqlite";
import { describe, expect, it } from "@alchemy.run/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { d1Executor, type D1Like } from "../../src/Store/D1.ts";
import { asyncOf } from "../../src/Store/Sql.ts";
import { fromDatabase } from "../../src/Store/SqliteDriver.ts";

/**
 * What one atomic unit means on each kind of target. A database with an
 * interactive transaction holds one open across the effect's reads and writes;
 * a target that only has an atomic multi-statement call collects the effect's
 * writes and commits them in one call. Both must roll back a failure, and both
 * must say which isolation they offer.
 */
describe("an atomic unit", () => {
  it.effect("SQLite holds one transaction open across the effect's reads and writes", () =>
    Effect.gen(function* () {
      const sql = fromDatabase(new Database(":memory:"));
      const async = asyncOf(sql);
      yield* async.batch(["CREATE TABLE t (n INTEGER NOT NULL)"]);

      yield* async.atomic(
        Effect.gen(function* () {
          yield* async.batch(["INSERT INTO t (n) VALUES (1)"]);
          // The write is visible inside the same unit, which is what a store
          // needs to compute the next sequence from the log it just wrote.
          const rows = yield* async.query<{ n: number }>("SELECT n FROM t");
          expect(rows.map((row) => row.n)).toEqual([1]);
        }),
      );
      expect((yield* async.query("SELECT n FROM t")).length).toBe(1);
      expect(async.isolation).toBe("serializable");
      sql.close();
    }),
  );

  it.effect("SQLite rolls the whole unit back when it fails", () =>
    Effect.gen(function* () {
      const sql = fromDatabase(new Database(":memory:"));
      const async = asyncOf(sql);
      yield* async.batch(["CREATE TABLE t (n INTEGER NOT NULL)"]);

      const exit = yield* Effect.exit(
        async.atomic(
          Effect.gen(function* () {
            yield* async.batch(["INSERT INTO t (n) VALUES (1)"]);
            return yield* Effect.fail("no");
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // Nothing survived: a failure is not a partial commit.
      expect(yield* async.query("SELECT n FROM t")).toEqual([]);
      sql.close();
    }),
  );

  it.effect("SQLite takes one writer at a time, so two units cannot interleave", () =>
    Effect.gen(function* () {
      const sql = fromDatabase(new Database(":memory:"));
      const async = asyncOf(sql);
      yield* async.batch(["CREATE TABLE t (n INTEGER NOT NULL)"]);

      yield* Effect.forEach(
        [1, 2, 3],
        (n) => async.atomic(async.batch([`INSERT INTO t (n) VALUES (${n})`])),
        { concurrency: "unbounded", discard: true },
      );

      // Each unit held the writer's lock for its whole body, so the rows are
      // exactly the three commitments and none was lost to an interleave.
      expect(
        (yield* async.query<{ n: number }>("SELECT n FROM t ORDER BY n")).map((row) => row.n),
      ).toEqual([1, 2, 3]);
      sql.close();
    }),
  );

  it.effect("SQLite keeps a write outside a unit out of that unit's transaction", () =>
    Effect.gen(function* () {
      const sql = fromDatabase(new Database(":memory:"));
      const async = asyncOf(sql);
      yield* async.batch(["CREATE TABLE t (n INTEGER NOT NULL)"]);

      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // A unit that holds the writer and then fails. A batch started meanwhile
      // belongs to its caller, not to this transaction: with a shared
      // connection and a plain depth counter it would join the unit and roll
      // back with it.
      const unit = yield* Effect.forkChild(
        Effect.exit(
          async.atomic(
            Effect.gen(function* () {
              yield* async.batch(["INSERT INTO t (n) VALUES (1)"]);
              yield* Deferred.succeed(started, void 0);
              yield* Deferred.await(release);
              return yield* Effect.fail("rollback");
            }),
          ),
        ),
      );
      yield* Deferred.await(started);
      const outside = yield* Effect.forkChild(async.batch(["INSERT INTO t (n) VALUES (2)"]));
      yield* Deferred.succeed(release, void 0);

      expect(Exit.isFailure(yield* Fiber.join(unit))).toBe(true);
      yield* Fiber.join(outside);
      expect(
        (yield* async.query<{ n: number }>("SELECT n FROM t ORDER BY n")).map((row) => row.n),
      ).toEqual([2]);
      sql.close();
    }),
  );

  it.effect("D1 collects a unit's writes and commits them in one batch", () =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<string>> = [];
      const d1: D1Like = {
        prepare: (sql: string) => ({
          sql,
          bind: () => ({ sql, all: async () => ({ results: [] }) }),
          all: async () => ({ results: [] }),
        }),
        batch: async (statements) => {
          batches.push(statements.map((statement) => String(statement.sql)));
        },
      };
      const async = asyncOf(d1Executor(d1));
      expect(async.isolation).toBe("deferred");

      yield* async.atomic(
        Effect.gen(function* () {
          yield* async.batch(["INSERT INTO t (n) VALUES (1)"]);
          yield* async.batch(["INSERT INTO t (n) VALUES (2)"]);
          // Deferred, not committed: nothing has reached the database yet.
          expect(batches.length).toBe(0);
        }),
      );
      // One call, both statements: the closest D1 has to a transaction.
      expect(batches).toEqual([["INSERT INTO t (n) VALUES (1)", "INSERT INTO t (n) VALUES (2)"]]);
    }),
  );

  it.effect("D1 commits a write from another fiber outside the open unit", () =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<string>> = [];
      const d1: D1Like = {
        prepare: (sql: string) => ({
          sql,
          bind: () => ({ sql, all: () => Promise.resolve({ results: [] }) }),
          all: () => Promise.resolve({ results: [] }),
        }),
        batch: (statements) => {
          batches.push(statements.map((statement) => String(statement.sql)));
          return Promise.resolve();
        },
      };
      const async = asyncOf(d1Executor(d1));
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const unit = yield* Effect.forkChild(
        async.atomic(
          Effect.gen(function* () {
            yield* async.write("INSERT INTO t (n) VALUES (1)");
            yield* Deferred.succeed(started, void 0);
            yield* Deferred.await(release);
          }),
        ),
      );
      yield* Deferred.await(started);
      // Another request's write must not join this unit's batch: it commits on
      // its own, before the unit does.
      yield* async.write("INSERT INTO t (n) VALUES (2)");
      expect(batches).toEqual([["INSERT INTO t (n) VALUES (2)"]]);
      yield* Deferred.succeed(release, void 0);
      yield* Fiber.join(unit);
      expect(batches).toEqual([["INSERT INTO t (n) VALUES (2)"], ["INSERT INTO t (n) VALUES (1)"]]);
    }),
  );

  it.effect("D1 drops a failed unit's writes instead of committing them", () =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<string>> = [];
      const d1: D1Like = {
        prepare: (sql: string) => ({
          sql,
          bind: () => ({ sql, all: async () => ({ results: [] }) }),
          all: async () => ({ results: [] }),
        }),
        batch: async (statements) => {
          batches.push(statements.map((statement) => String(statement.sql)));
        },
      };
      const async = asyncOf(d1Executor(d1));
      const exit = yield* Effect.exit(
        async.atomic(
          Effect.gen(function* () {
            yield* async.batch(["INSERT INTO t (n) VALUES (1)"]);
            return yield* Effect.fail("no");
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(batches).toEqual([]);
    }),
  );

  it.effect("D1 commits a batch immediately when it is not in a unit", () =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<string>> = [];
      const d1: D1Like = {
        prepare: (sql: string) => ({
          sql,
          bind: () => ({ sql, all: async () => ({ results: [] }) }),
          all: async () => ({ results: [] }),
        }),
        batch: async (statements) => {
          batches.push(statements.map((statement) => String(statement.sql)));
        },
      };
      yield* asyncOf(d1Executor(d1)).batch(["CREATE TABLE t (n INTEGER)"]);
      expect(batches.length).toBe(1);
    }),
  );

  it.effect("D1 refuses the synchronous half rather than blocking", () =>
    Effect.gen(function* () {
      const d1: D1Like = {
        prepare: () => ({ bind: () => ({ all: async () => ({}) }), all: async () => ({}) }),
        batch: async () => ({}),
      };
      const sql = d1Executor(d1);
      const exit = yield* Effect.sync(() => {
        try {
          sql.all("SELECT 1");
          return "ran";
        } catch (error) {
          return String(error);
        }
      });
      expect(exit).toContain("no synchronous all");
    }),
  );
});
