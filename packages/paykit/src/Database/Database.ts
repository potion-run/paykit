import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { SqlDialect, SqlExecutor } from "../Store/Sql.ts";

/**
 * The database a deployment writes its billing model to.
 *
 * It is the same seam Alchemy's `BetterAuth.Database` is, for the same reason:
 * the model never learns which platform answered. The service describes only
 * the runtime plane — a dialect, the schema, and an executor acquired on the
 * scope of whoever is running. Deploy-time migration support is a separate
 * service, `Paykit.DatabaseMigrate`, so a host that cannot migrate (a Node
 * process that owns its own schema) provides this one and nothing else.
 *
 * `executor` is acquired once per execution and released with that execution's
 * scope. A Worker scopes it to the request, because its sockets are pinned to
 * the request that owns them; a Node host provides a longer-lived scope and
 * keeps one pool for the process. The port does not name which: the scope the
 * caller provides is the lifetime.
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
 *   const applied = yield* Paykit.sync(yield* database.executor);
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
   * execution's scope and released when it closes. A Worker scopes it to the
   * request; a Node process scopes it to the process. Never acquire it at
   * module scope: a Worker's sockets belong to one request.
   */
  readonly executor: Effect.Effect<SqlExecutor, never, Scope.Scope>;
}

/**
 * The billing database as a service. Provide one layer, read the executor from
 * it: a Worker, a test and a deploy then share one description of where the
 * ledger lives.
 *
 * @primitive
 */
export class Database extends Context.Service<Database, DatabaseService>()("paykit/Database") {}
