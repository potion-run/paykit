import type { Input, RuntimeContext } from "alchemy";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { MigrationApplyError } from "../Migrations/index.ts";
import type { SqlDialect, SqlExecutor } from "../Store/Sql.ts";

/**
 * Deploy-time migration support for one target: the identity a deploy records
 * and the connection it applies files through.
 *
 * The connection is two-stage, mirroring Alchemy's own resource doctrine. The
 * OUTER effect runs while the stack is evaluated, so the resource Outputs it
 * yields — a database id, a connection-string attribute — become dependency
 * captures that resolve at apply time. The INNER effect runs at apply, opens
 * the connection on the deploy's scope, and yields the executor the migration
 * runs against. No I/O in the outer half, ever.
 */
export interface DatabaseMigrate {
  /**
   * Non-secret identity of the target database, part of the migration Action's
   * input so a replaced database re-runs the migration even when the schema is
   * unchanged. It is persisted to Alchemy state, so it must never contain a
   * connection string — a digest of one is what a layer supplies.
   */
  readonly identity: Input<Record<string, unknown>>;
  /** Two-stage connection: capture at deploy, connect at apply. */
  readonly connect: Effect.Effect<
    Effect.Effect<SqlExecutor, MigrationApplyError, Scope.Scope>,
    never,
    RuntimeContext
  >;
}

/**
 * The database a deployment writes its billing model to.
 *
 * It is the same seam Alchemy's `BetterAuth.Database` is, for the same reason:
 * the model never learns which platform answered. `runtime` is the executor a
 * request uses (memoized on the execution scope, so a pool closes when the
 * event settles); `migrate` is the deploy's own connection, absent when the
 * target cannot migrate (Memory) or when another resource owns the schema
 * (Cloudflare D1 applies its `migrations` directory).
 *
 * ### Providing a target
 * **Example:** SQLite for a test, Postgres for the deploy
 * ```ts
 * import { Sqlite } from "@potion.run/paykit/Database/Sqlite";
 *
 * const Store = Sqlite({ filename: ":memory:" });
 *
 * Effect.gen(function* () {
 *   const database = yield* Paykit.Database;
 *   const applied = yield* Paykit.sync(yield* database.runtime);
 * }).pipe(Effect.provide(Store));
 * ```
 *
 * @primitive
 */
export interface DatabaseService {
  /** The SQL dialect the target speaks; selects the DDL and placeholder shape. */
  readonly dialect: SqlDialect;
  /** The Postgres schema every `billing_*` table lives in. SQLite ignores it. */
  readonly schema?: string;
  /**
   * The executor one execution uses — a connection or binding acquired on the
   * execution's scope. Never acquire it at module scope: a Worker's sockets are
   * pinned to the request that owns them.
   */
  readonly runtime: Effect.Effect<SqlExecutor, never, RuntimeContext | Scope.Scope>;
  /** Deploy-time migration support. Absent means this target cannot migrate. */
  readonly migrate?: DatabaseMigrate;
}

/**
 * The billing database as a service. Provide one layer, read the executor from
 * it: a Worker, a test and a deploy then share one description of where the
 * ledger lives.
 *
 * @primitive
 */
export class Database extends Context.Service<Database, DatabaseService>()("paykit/Database") {}
