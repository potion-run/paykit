// The database port is the deploy-time and runtime seam in one service. These
// cases pin the parts a deployment depends on: a layer supplies a runtime
// executor, a migratable target exposes an identity and a connection, and the
// registration is inert outside a stack — so a test or a Worker never
// accidentally registers an Action.
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Database } from "../src/Database/Database.ts";
import type { DatabaseService } from "../src/Database/Database.ts";
import { registerMigrations } from "../src/Database/Migrate.ts";
import { Sqlite } from "../src/Database/Sqlite.ts";
import { sync } from "../src/Migrations/index.ts";

/** Run one effect against a SQLite layer, with the layer's scope. */
const withSqlite = <A, E>(effect: Effect.Effect<A, E, Database | Scope.Scope | RuntimeContext>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Sqlite());

      return yield* effect.pipe(Effect.provideContext(context));
    }),
  ).pipe(Effect.provide(RuntimeContext.phantom));

describe("the database port", () => {
  it.live("a layer supplies a dialect, a runtime, and a migration identity", () =>
    withSqlite(
      Effect.gen(function* () {
        const database = yield* Database;

        expect(database.dialect).toBe("sqlite");
        expect(database.migrate?.identity).toEqual({ filename: ":memory:" });

        const sql = yield* database.runtime;
        const migrated = yield* sync(sql);
        expect(migrated.applied).toEqual(["0001_init"]);
      }),
    ),
  );

  it.live("runtime executors are per execution, not module state", () =>
    withSqlite(
      Effect.gen(function* () {
        const database = yield* Database;
        const first = yield* database.runtime;
        const second = yield* database.runtime;

        // Each acquisition is its own executor, closed with the execution's
        // scope; sharing one across requests is the mistake this prevents.
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
    }).pipe(Effect.provide(Sqlite()), Effect.provide(RuntimeContext.phantom)),
  );

  it.live("`migrate: true` on a target without migration support dies", () =>
    Effect.gen(function* () {
      const runtimeOnly: DatabaseService = {
        dialect: "sqlite",
        runtime: Effect.die("the runtime is not used by registration"),
      };

      const exit = yield* Effect.exit(
        registerMigrations("Billing", { migrate: true }).pipe(
          Effect.provideService(Database, runtimeOnly),
          Effect.provide(RuntimeContext.phantom),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("does not support automatic migrations");
    }),
  );
});
