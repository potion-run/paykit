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
 */
export const billingOnPostgres = (
  sql: SqlExecutor,
  options: { readonly now?: () => number } = {},
): BillingOnPostgres => {
  const now = options.now ?? (() => Date.now());
  const log = SqlEventLog(sql, { now, schema: "billing" });
  const { platform } = SqlPlatform(sql, log, { now, pollMillis: 50, schema: "billing" });

  return { log, world: postgresWorld(log, platform) };
};
