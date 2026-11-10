// A raw `pg` pool is the second way to reach Postgres, after `@effect/sql-pg`:
// the pool a Drizzle instance already holds, or one an application opened. The
// case that matters is `atomic` — the unit must run *on the checked-out
// client*, so a read sees the writes before the commit, and a failure rolls
// back everything the unit wrote.
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Database } from "../../src/Database/Database.ts";
import { Drizzle } from "../../src/Database/Drizzle.ts";
import { pgPoolExecutor } from "../../src/Store/PostgresDriver.ts";
import type { PgClientLike, PgPoolLike } from "../../src/Store/PostgresDriver.ts";
import { asyncOf } from "../../src/Store/Sql.ts";

/** A pool that records every statement, and the client a unit checks out. */
const fakePool = () => {
  const statements: string[] = [];

  const client: PgClientLike = {
    query: (sql) => {
      statements.push(`client:${sql}`);

      return Promise.resolve({ rows: [] });
    },
    release: () => {
      statements.push("client:release");
    },
  };

  const pool: PgPoolLike = {
    query: (sql) => {
      statements.push(`pool:${sql}`);

      return Promise.resolve({ rows: [] });
    },
    connect: () => Promise.resolve(client),
  };

  return { pool, statements };
};

describe("a raw pg pool", () => {
  it.live("rewrites paykit's placeholders before the pool sees them", () =>
    Effect.gen(function* () {
      const { pool, statements } = fakePool();

      yield* asyncOf(pgPoolExecutor(pool)).query("SELECT * FROM t WHERE a = ? AND b = ?", ["x", 1]);

      expect(statements).toEqual(["pool:SELECT * FROM t WHERE a = $1 AND b = $2"]);
    }),
  );

  it.live("runs one unit on the checked-out client, between BEGIN and COMMIT", () =>
    Effect.gen(function* () {
      const { pool, statements } = fakePool();
      const sql = asyncOf(pgPoolExecutor(pool));

      yield* sql.atomic(
        Effect.gen(function* () {
          yield* sql.write("UPDATE t SET a = ?", ["x"]);
          yield* sql.query("SELECT * FROM t");
        }),
      );

      expect(statements).toEqual([
        "client:BEGIN",
        "client:UPDATE t SET a = $1",
        "client:SELECT * FROM t",
        "client:COMMIT",
        "client:release",
      ]);
    }),
  );

  it.live("rolls the unit back and releases the client when it fails", () =>
    Effect.gen(function* () {
      const { pool, statements } = fakePool();
      const sql = asyncOf(pgPoolExecutor(pool));

      const exit = yield* Effect.exit(
        sql.atomic(
          Effect.gen(function* () {
            yield* sql.write("UPDATE t SET a = ?", ["x"]);

            return yield* Effect.fail("refused");
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(statements).toContain("client:ROLLBACK");
      expect(statements).not.toContain("client:COMMIT");
      expect(statements.at(-1)).toBe("client:release");
    }),
  );

  it.live("a statement outside a unit goes to the pool", () =>
    Effect.gen(function* () {
      const { pool, statements } = fakePool();

      yield* asyncOf(pgPoolExecutor(pool)).write("INSERT INTO t VALUES (?)", [1]);

      expect(statements).toEqual(["pool:INSERT INTO t VALUES ($1)"]);
    }),
  );
});

describe("the Drizzle layer", () => {
  it.live("adopts the pool Drizzle already opened", () => {
    const { pool } = fakePool();

    return Effect.gen(function* () {
      const database = yield* Database;

      expect(database.dialect).toBe("postgres");
      expect(database.schema).toBe("billing");
      expect(database.migrate?.identity).toEqual({ dialect: "postgres", schema: "billing" });
      expect(Effect.isEffect(database.runtime)).toBe(true);
    }).pipe(Effect.provide(Drizzle({ $client: pool })));
  });

  it.live("opts out of migrating when the application owns the pipeline", () => {
    const { pool } = fakePool();

    return Effect.gen(function* () {
      const database = yield* Database;

      expect(database.migrate).toBeUndefined();
    }).pipe(Effect.provide(Drizzle({ $client: pool }, { migrate: false })));
  });

  it.live("refuses a client that is not a pg pool", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.service(Database).pipe(Effect.provide(Drizzle({ $client: {} }))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("is not a `pg` Pool");
    }),
  );
});
