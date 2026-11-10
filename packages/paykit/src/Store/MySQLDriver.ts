import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlExecutor } from "./Sql.ts";
import { sqlClientExecutor } from "./SqlClientDriver.ts";

/**
 * A `SqlExecutor` over an `@effect/sql-mysql2` client — the client
 * `@alchemy.run/sql/MySQL` builds from a connection URL.
 *
 * MySQL binds `?` placeholders natively, so the adapter is
 * `postgresExecutor`'s shape without the rewrite: `query`, `write`, `batch`
 * and `atomic` come from the client's own transaction control, and the
 * synchronous half refuses.
 *
 * ### A MySQL client
 * **Example:** The model on a MySQL client
 * ```typescript
 * import * as SQL from "@alchemy.run/sql/MySQL";
 *
 * const client = yield* SQL.MySQL({ url: connectionString });
 * const log = Paykit.SqlEventLog(Paykit.mysqlExecutor(client), { now });
 * ```
 *
 * @primitive
 */
export const mysqlExecutor = (client: SqlClient.SqlClient): SqlExecutor =>
  sqlClientExecutor(client, "mysql");
