import {
  connectionSourceDigest,
  resolveConnectionSource,
  staticConnectionSource,
  type ConnectionSource,
  type StaticConnectionSource,
} from "@alchemy.run/sql/ConnectionSource";
import * as SQL from "@alchemy.run/sql/MySQL";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mysqlExecutor } from "../Store/MySQLDriver.ts";
import { Database, type DatabaseService } from "./Database.ts";

/** Options for the MySQL target. */
export interface MySQLOptions {
  /**
   * A deploy-resolvable connection for migrations. Defaults to `source` when it
   * is resolvable at deploy (a literal, a `Redacted`, a resource Output); a
   * runtime-only source has no default, so pass the origin URL here, or `false`
   * to run without migrations.
   */
  readonly migrate?: StaticConnectionSource | false;
}

/**
 * A MySQL billing database, from any connection source.
 *
 * The client is Alchemy's own `SQL.MySQL` — an `@effect/sql-mysql2` pool that is
 * built once per execution and closed when the event settles — adapted to
 * paykit's executor by `mysqlExecutor`. MySQL binds `?` natively, so there is
 * no placeholder rewrite.
 *
 * MySQL has no schema separate from the connection's database: `DatabaseService.schema`
 * stays undefined and every table is quoted with backticks. Migration identity
 * is the digest of the deploy URL, never the URL itself.
 *
 * Import it from `@potion.run/paykit/Database/MySQL`, not the barrel:
 * `@effect/sql-mysql2` and `mysql2` are optional peers.
 *
 * ### A MySQL host
 * **Example:** The deploy URL, and an origin for migrations
 * ```ts
 * import { MySQL } from "@potion.run/paykit/Database/MySQL";
 *
 * Effect.gen(function* () {
 *   yield* Paykit.registerMigrations("Billing");
 * }).pipe(Effect.provide(MySQL(Config.Redacted("MYSQL_URL"), {
 *   migrate: Config.Redacted("MYSQL_MIGRATION_URL"),
 * })));
 * ```
 *
 * @layer
 * @provides paykit/Database
 * @peer @effect/sql-mysql2
 * @peer mysql2
 * @product MySQL
 */
export const MySQL = (
  source: ConnectionSource,
  options: MySQLOptions = {},
): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const url = yield* resolveConnectionSource(source);
      const migrateSource = staticConnectionSource(source, options.migrate);

      return {
        dialect: "mysql",
        runtime: Effect.map(SQL.MySQL({ url }), mysqlExecutor),
        ...(migrateSource === undefined
          ? {}
          : {
              migrate: {
                identity: { urlDigest: connectionSourceDigest(migrateSource) },
                connect: Effect.succeed(
                  Effect.gen(function* () {
                    const migrateUrl = yield* resolveConnectionSource(migrateSource);
                    const client = yield* SQL.MySQL({ url: migrateUrl });

                    return mysqlExecutor(client);
                  }),
                ),
              },
            }),
      } satisfies DatabaseService;
    }),
  );
