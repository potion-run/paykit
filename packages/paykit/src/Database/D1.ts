import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { d1Executor, type D1Like } from "../Store/D1.ts";
import { Database, type DatabaseService } from "./Database.ts";

/**
 * A Cloudflare D1 billing database.
 *
 * Runtime access goes through the Worker's native binding (the layer pulls in
 * `Cloudflare.D1.QueryDatabaseBinding`). There is deliberately **no**
 * `migrate`: the `Cloudflare.D1.Database` resource applies its `migrations`
 * directory at deploy, in name order, with its own bookkeeping. Registering a
 * second migrator for the same schema would race it, so `Paykit.registerMigrations`
 * on this target is a no-op unless `migrate: true` is forced — which fails with
 * a message naming this reason.
 *
 * Import it from `@potion.run/paykit/Database/D1`, not the barrel: it carries
 * `@alchemy.run/cloudflare`, an optional peer.
 *
 * ### A D1-backed model
 * **Example:** The binding, and the resource that owns the schema
 * ```ts
 * const Db = Cloudflare.D1.Database("BillingDb", { migrations: "./migrations" });
 *
 * Effect.gen(function* () {
 *   const database = yield* Paykit.Database;
 *   const sql = yield* database.runtime;
 *   // ...
 * }).pipe(Effect.provide(D1(Db)));
 * ```
 *
 * @layer
 * @provides paykit/Database
 * @peer @alchemy.run/cloudflare
 * @product D1
 */
export const D1 = (database: Cloudflare.D1.Database) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* Cloudflare.D1.QueryDatabase(database);

      return {
        dialect: "sqlite",
        // SAFETY: the raw binding is Cloudflare's D1Database; `D1Like` is its structural subset (prepare/bind/all/batch).
        runtime: Effect.map(client.raw, (raw) => d1Executor(raw as D1Like)),
      } satisfies DatabaseService;
    }),
  ).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding));
