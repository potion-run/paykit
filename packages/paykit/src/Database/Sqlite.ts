import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqliteDriver } from "../Store/SqliteDriver.ts";
import { Database, type DatabaseService } from "./Database.ts";
import { DatabaseMigrate, type DatabaseMigrateService } from "./Migrate.ts";

/** What a SQLite target needs: a file, or `:memory:` (the default). */
export interface SqliteOptions {
  /**
   * The database file. Absent means `:memory:`, which is right for a test and
   * wrong for a deployment — a Worker cannot open a local file.
   */
  readonly filename?: string;
}

const open = (filename: string) =>
  Effect.acquireRelease(
    Effect.sync(() => SqliteDriver({ filename })),
    (sql) => Effect.sync(() => sql.close()),
  );

/**
 * A `bun:sqlite` billing database — development, tests, and a single-process
 * host. The same file is opened for the runtime and for migrations, so
 * `Paykit.sync` and the model read one database.
 *
 * It provides both planes: `Database` for requests, and `DatabaseMigrate` for
 * the deploy. A host that owns its schema can provide only the first by
 * opening the executor itself, without this layer.
 *
 * Import it from `@potion.run/paykit/Database/Sqlite`, not the barrel: it pulls
 * `bun:sqlite`, which a Node consumer must not load.
 *
 * ### A durable model in one process
 * **Example:** Migrate the file, then serve from it
 * ```ts
 * import { Sqlite } from "@potion.run/paykit/Database/Sqlite";
 *
 * const SqliteDb = Sqlite({ filename: "billing.db" });
 *
 * Effect.gen(function* () {
 *   const database = yield* Paykit.Database;
 *   yield* Paykit.sync(yield* database.executor); // or a deploy step
 * }).pipe(Effect.provide(SqliteDb));
 * ```
 *
 * @layer
 * @provides paykit/Database
 * @product SQLite
 */
export const Sqlite = (options: SqliteOptions = {}): Layer.Layer<Database> => {
  const filename = options.filename ?? ":memory:";

  const database = Layer.succeed(Database, {
    dialect: "sqlite",
    executor: open(filename),
  } satisfies DatabaseService);

  const migrate = Layer.succeed(DatabaseMigrate, {
    identity: { filename },
    connect: Effect.succeed(open(filename)),
  } satisfies DatabaseMigrateService);

  return Layer.merge(database, migrate);
};
