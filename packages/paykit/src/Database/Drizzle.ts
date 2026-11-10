import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { pgPoolExecutor, type PgPoolLike } from "../Store/PostgresDriver.ts";
import { DEFAULT_SCHEMA } from "../Store/Tables.ts";
import { Database, type DatabaseService } from "./Database.ts";

/** What the layer needs from a Drizzle database: the client it already holds. */
export interface DrizzleLike {
  /** Drizzle v1 exposes the underlying driver here (a `pg` Pool, a SQLite handle, ...). */
  readonly $client: unknown;
}

/** How to run paykit on a database Drizzle already opened. */
export interface DrizzleOptions {
  /** The Postgres schema every `billing_*` table lives in. Defaults to `billing`. */
  readonly schema?: string;
  /**
   * Non-secret identity of the target, recorded in the migration Action's
   * input. Defaults to `{ dialect, schema }`; pass a digest of the connection
   * when two databases share a schema and a deploy must tell them apart.
   */
  readonly identity?: Record<string, unknown>;
  /**
   * `false` when the application's own migration pipeline applies paykit's
   * tables (`Paykit.sync` over the same executor). Default: migrate on deploy.
   */
  readonly migrate?: boolean;
}

const isPool = (value: unknown): value is PgPoolLike =>
  typeof value === "object" &&
  value !== null &&
  "query" in value &&
  typeof value.query === "function" &&
  "connect" in value &&
  typeof value.connect === "function";

/**
 * The billing model on a Postgres database a Drizzle instance already opened.
 *
 * paykit never uses Drizzle's query builder — its stores write SQL through the
 * executor — so this layer is a connection adapter, not an ORM integration. It
 * unwraps `db.$client`, and every statement then runs on the pool the
 * application already owns: one pool, one transaction boundary, no second
 * connection string.
 *
 * Only a `pg` pool is accepted. A Drizzle SQLite handle is better served by the
 * `Database/Sqlite` layer over the same file, and MySQL is not a paykit target
 * (a `TEXT` primary key needs a prefix length there, which is a different
 * schema, not a different dialect).
 *
 * Import it from `@potion.run/paykit/Database/Drizzle`, not the barrel: `pg` is
 * an optional peer, and the client type is structural.
 *
 * ### The pool your application already has
 * **Example:** Drizzle's client, paykit's executor
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { Drizzle } from "@potion.run/paykit/Database/Drizzle";
 *
 * const db = drizzle({ client: pool });
 *
 * Effect.gen(function* () {
 *   yield* Paykit.BillingStack("Billing", { ...billing, migrate: true });
 * }).pipe(Effect.provide(Drizzle(db, { schema: "billing" })));
 * ```
 *
 * @layer
 * @provides paykit/Database
 * @peer pg
 * @product Postgres
 */
export const Drizzle = <R = never>(
  db: DrizzleLike | Effect.Effect<DrizzleLike, never, R>,
  options: DrizzleOptions = {},
) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const drizzle = Effect.isEffect(db) ? yield* db : db;
      const client = drizzle.$client;

      if (!isPool(client)) {
        return yield* Effect.die(
          new Error(
            "Paykit(Database.Drizzle): the database's `$client` is not a `pg` Pool. " +
              "Pass a `drizzle(...)` instance from `drizzle-orm/node-postgres`, or use " +
              "`Database/Sqlite` over the same file for SQLite.",
          ),
        );
      }

      const sql = pgPoolExecutor(client);
      const schema = options.schema ?? DEFAULT_SCHEMA;

      return {
        dialect: "postgres",
        schema,
        runtime: Effect.succeed(sql),
        ...(options.migrate === false
          ? {}
          : {
              migrate: {
                identity: options.identity ?? { dialect: "postgres", schema },
                connect: Effect.succeed(Effect.succeed(sql)),
              },
            }),
      } satisfies DatabaseService;
    }),
  );
