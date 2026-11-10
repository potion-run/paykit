import * as Domain from "@alchemy.run/domain";
import {
  InsecureDevGuards,
  Paykit,
  SqlBillingReadStore,
  SqlEventLog,
  SqlPlatform,
  type SqlExecutor,
} from "@potion.run/paykit";
import * as Layer from "effect/Layer";
import { billing } from "./billing.config.ts";

/**
 * The same world the other examples build, on Postgres: the SQL event log, the
 * SQL platform and the SQL read store, with the catalog's tables in the
 * `billing` schema.
 */
const postgresWorld = (log: SqlEventLog, platform: Domain.Platform["Service"]) =>
  Paykit.world({
    ...billing,
    platform: Layer.succeed(Domain.Platform, platform),
    readStore: SqlBillingReadStore(log),
    guards: InsecureDevGuards,
  });

/** Everything a Postgres-hosted world provides. */
export type PostgresWorld = ReturnType<typeof postgresWorld>;

/** What `billingOnPostgres` gives back: the log, and the model hosted on it. */
export interface BillingOnPostgres {
  readonly log: SqlEventLog;
  readonly world: PostgresWorld;
}

/**
 * Host the billing model on the executor a Drizzle pool yields. The function is
 * the same one `examples/postgres` uses; only where the executor comes from
 * changes, which is the port's whole claim.
 *
 * `schema` names the Postgres schema both stores use, and must match the one
 * the deploy migrates. It defaults to `billing`.
 */
export const billingOnPostgres = (
  sql: SqlExecutor,
  options: { readonly now: () => number; readonly schema?: string },
): BillingOnPostgres => {
  const now = options.now;
  const schema = options.schema ?? "billing";
  const log = SqlEventLog(sql, { now, schema });
  const { platform } = SqlPlatform(sql, log, { now, pollMillis: 50, schema });

  return { log, world: postgresWorld(log, platform) };
};
