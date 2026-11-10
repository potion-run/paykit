import {
  connectionSourceDigest,
  resolveConnectionSource,
  staticConnectionSource,
  type ConnectionSource,
  type StaticConnectionSource,
} from "@alchemy.run/sql/ConnectionSource";
import * as SQL from "@alchemy.run/sql/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { postgresExecutor } from "../Store/PostgresDriver.ts";
import { DEFAULT_SCHEMA } from "../Store/Tables.ts";
import { Database, type DatabaseService } from "./Database.ts";
import { DatabaseMigrate, type DatabaseMigrateService } from "./Migrate.ts";

/** Options for the Postgres target. */
export interface PostgresOptions {
  /** The schema every `billing_*` table lives in. Defaults to `billing`. */
  readonly schema?: string;
  /**
   * A deploy-resolvable connection for migrations. Defaults to `source` when it
   * is resolvable at deploy (a literal, a `Redacted`, a resource Output); a
   * runtime-only source — a Hyperdrive binding — has no default, so pass the
   * origin URL here, or `false` to run without migrations.
   */
  readonly migrate?: StaticConnectionSource | false;
}

/**
 * A Postgres billing database, from any connection source: a Hyperdrive
 * connection string, Neon, PlanetScale Postgres, RDS, or a literal URL.
 *
 * One pool is opened on the caller's scope and closed when that scope closes.
 * A Worker scopes it to the request, which is the only legal pooling shape on
 * workerd; a Node host scopes it to the process. The port does not decide.
 * Migrations use `migrate` when it is given, because the runtime URL may only
 * exist inside the Worker — the same split Alchemy's `Postgres` layer for
 * Better Auth makes, and the reason a deployment can keep a restricted runtime
 * role.
 *
 * Import it from `@potion.run/paykit/Database/Postgres`, not the barrel:
 * `@effect/sql-pg` is an optional peer.
 *
 * ### Pooled runtime, direct migrations
 * **Example:** Hyperdrive for requests, the origin for the deploy
 * ```ts
 * import { Postgres } from "@potion.run/paykit/Database/Postgres";
 *
 * const Store = Postgres(hyperdrive.connectionString, {
 *   migrate: Config.redacted("POSTGRES_URL"),
 *   schema: "billing",
 * });
 * ```
 *
 * @layer
 * @provides paykit/Database
 * @peer @effect/sql-pg
 * @peer pg
 * @product Postgres
 */
export const Postgres = (
  source: ConnectionSource,
  options: PostgresOptions = {},
): Layer.Layer<Database> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const url = yield* resolveConnectionSource(source);
      const migrateSource = staticConnectionSource(source, options.migrate);

      const database = Layer.succeed(Database, {
        dialect: "postgres",
        schema: options.schema ?? DEFAULT_SCHEMA,
        executor: Effect.map(SQL.Postgres({ url }), postgresExecutor),
      } satisfies DatabaseService);

      const migrate =
        migrateSource === undefined
          ? Layer.empty
          : Layer.succeed(DatabaseMigrate, {
              // A digest, never the URL: the Action's input is persisted to
              // Alchemy state, and the connection string is a secret.
              identity: { urlDigest: connectionSourceDigest(migrateSource) },
              connect: Effect.succeed(
                Effect.gen(function* () {
                  const migrateUrl = yield* resolveConnectionSource(migrateSource);
                  const client = yield* SQL.Postgres({ url: migrateUrl });

                  return postgresExecutor(client);
                }),
              ),
            } satisfies DatabaseMigrateService);

      return Layer.merge(database, migrate);
    }),
  );
