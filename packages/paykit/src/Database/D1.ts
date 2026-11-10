import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { MigrationApplyError } from "../Migrations/index.ts";
import { d1Executor, type D1Like } from "../Store/D1.ts";
import type { SqlExecutor } from "../Store/Sql.ts";
import { Database, type DatabaseService } from "./Database.ts";
import { DatabaseMigrate, type DatabaseMigrateService } from "./Migrate.ts";

// SAFETY: the raw binding is Cloudflare's D1Database; `D1Like` is its structural subset (prepare/bind/all/batch).
const executorOver = (raw: unknown): SqlExecutor => d1Executor(raw as D1Like);

/**
 * A Cloudflare D1 billing database.
 *
 * At runtime the Worker reaches the database through its native binding (the
 * layer pulls in `Cloudflare.D1.QueryDatabaseBinding`). At migration time the
 * deploy uses the D1 HTTP query API — which also targets the local simulator
 * under `alchemy dev` — so the Worker's binding is never used outside the
 * runtime, and the migration code is tree-shaken out of the deployed bundle.
 * The structure is Alchemy's own `CloudflareD1` layer for Better Auth, with
 * paykit's executor in place of the Kysely one.
 *
 * Import it from `@potion.run/paykit/Database/D1`, not the barrel: it carries
 * `@alchemy.run/cloudflare`, an optional peer.
 *
 * ### A D1-backed model
 * **Example:** The binding, and the deploy that migrates it
 * ```ts
 * const Db = Cloudflare.D1.Database("BillingDb");
 *
 * Effect.gen(function* () {
 *   const stack = yield* Paykit.BillingStack("Billing", { ...billing, migrate: true });
 *   return { tiers: stack.tiers };
 * }).pipe(Effect.provide(D1(Db)));
 * ```
 *
 * @layer
 * @provides paykit/Database
 * @peer @alchemy.run/cloudflare
 * @product D1
 */
export const D1 = <R = never>(
  database: Cloudflare.D1.Database | Effect.Effect<Cloudflare.D1.Database, never, R>,
): Layer.Layer<Database, never, R> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const resource = Effect.isEffect(database) ? yield* database : database;

      const databaseLayer = Layer.succeed(Database, {
        dialect: "sqlite",
        // Resolved per execution, so the layer itself needs no binding: a Worker
        // host provides `Cloudflare.D1.QueryDatabaseBinding`; a deploy host only
        // uses the migration branch below.
        executor: (() => {
          const resolved: unknown = Effect.gen(function* () {
            const client = yield* Cloudflare.D1.QueryDatabase(resource);

            return executorOver(yield* client.raw);
          });

          // SAFETY: `QueryDatabase` is the Worker's binding, which the host
          // provides; the `DatabaseService` contract names only the services a
          // caller of `executor` must own.
          return resolved as Effect.Effect<SqlExecutor, never, Scope.Scope>;
        })(),
      } satisfies DatabaseService);

      // Migration support references the HTTP/local D1 client, which must never
      // reach a Worker bundle: this branch is dead-code-eliminated from deployed
      // runtimes, which also tree-shakes the local-runtime machinery out.
      const migrateLayer = globalThis.__ALCHEMY_RUNTIME__
        ? Layer.empty
        : Layer.succeed(DatabaseMigrate, {
            identity: { databaseId: resource.databaseId },
            // Init half: `QueryDatabase` yields the database id, recording the
            // dependency; the client's `raw` resolves at apply, which is why the
            // result is an Effect of an Effect.
            connect: Effect.map(Cloudflare.D1.QueryDatabase(resource), (local) =>
              Effect.map(local.raw, executorOver),
            ).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal), (effect) => {
              const erased: unknown = effect;

              // SAFETY: the D1 HTTP client's build requirements are ambient
              // during stack evaluation, where the init half runs.
              return erased as Effect.Effect<
                Effect.Effect<SqlExecutor, MigrationApplyError, Scope.Scope>,
                never,
                RuntimeContext
              >;
            }),
          } satisfies DatabaseMigrateService);

      return Layer.merge(databaseLayer, migrateLayer);
    }),
  );
