// The database port has two planes. These cases pin both: a layer supplies a
// runtime executor, a migratable target exposes the deploy service beside it,
// and the registration is inert outside a stack — so a test or a Worker never
// accidentally registers an Action. None of them provides `RuntimeContext`,
// which is the port's claim: the runtime half is an Effect service, and only an
// adapter for a host that owns bindings may need one.
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Database } from "../src/Database/Database.ts";
import type { DatabaseService } from "../src/Database/Database.ts";
import { DatabaseMigrate, registerMigrations } from "../src/Database/Migrate.ts";
import { Sqlite } from "../src/Database/Sqlite.ts";
import { sync } from "../src/Migrations/index.ts";

/** Run one effect against a SQLite layer, with the layer's scope. */
const withSqlite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Sqlite());

      return yield* Effect.provide(effect, context);
    }),
  );

describe("the database port", () => {
  it.live("a layer supplies a dialect, an executor, and a migration identity", () =>
    withSqlite(
      Effect.gen(function* () {
        const database = yield* Database;
        const migrate = Option.getOrUndefined(yield* Effect.serviceOption(DatabaseMigrate));

        expect(database.dialect).toBe("sqlite");
        expect(migrate?.identity).toEqual({ filename: ":memory:" });

        const sql = yield* database.executor;
        const migrated = yield* sync(sql);
        expect(migrated.applied).toEqual(["0001_init"]);
      }),
    ),
  );

  it.live("executors are acquired from the scope, never module state", () =>
    withSqlite(
      Effect.gen(function* () {
        const database = yield* Database;
        const first = yield* database.executor;
        const second = yield* database.executor;

        // Each acquisition is its own executor, closed with the scope that
        // acquired it; sharing one across requests is the mistake this prevents.
        expect(first).not.toBe(second);
      }),
    ),
  );

  it.live("registering outside a stack is a no-op", () =>
    Effect.gen(function* () {
      // No `Stack` in this runtime: a test or a Worker must be able to call the
      // same registration the stack calls without an Action appearing.
      yield* registerMigrations("Billing");
      yield* registerMigrations("Billing", { migrate: false });
    }).pipe(Effect.provide(Sqlite())),
  );

  it.live("`migrate: true` on a target without migration support dies", () =>
    Effect.gen(function* () {
      const runtimeOnly: DatabaseService = {
        dialect: "sqlite",
        executor: Effect.die("the executor is not used by registration"),
      };

      const exit = yield* Effect.exit(
        registerMigrations("Billing", { migrate: true }).pipe(
          Effect.provideService(Database, runtimeOnly),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("does not support automatic migrations");
    }),
  );
});
