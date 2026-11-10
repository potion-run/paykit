import * as Domain from "@alchemy.run/domain";
import {
  InsecureDevGuards,
  Paykit,
  type SqlExecutor,
  SqlBillingReadStore,
  SqlEventLog,
  SqlPlatform,
} from "@potion.run/paykit";
import * as Layer from "effect/Layer";
import { billing } from "./billing.config.ts";

/**
 * The same world a D1 host builds, on Postgres: the SQL event log, the SQL
 * platform and the SQL read store, with the catalog's tables in the `billing`
 * schema the deploy migrates.
 *
 * The executor is the only platform-specific piece, which is what lets the
 * Worker and the test share this function: the Worker passes the executor from
 * its Hyperdrive connection, and the test passes the same executor over a
 * `POSTGRES_URL`.
 */
const postgresWorld = (log: SqlEventLog, platform: Domain.Platform["Service"]) =>
  Paykit.world({
    ...billing,
    platform: Layer.succeed(Domain.Platform, platform),
    readStore: SqlBillingReadStore(log),
    guards: InsecureDevGuards,
  });

/** Everything a Postgres-hosted world provides, and nothing it does not. */
export type PostgresWorld = ReturnType<typeof postgresWorld>;

/** What `billingOnPostgres` gives back: the log, and the model hosted on it. */
export interface BillingOnPostgres {
  readonly log: SqlEventLog;
  readonly world: PostgresWorld;
}

/**
 * Host the billing model on Postgres, exactly as `billingOnSql` hosts it on
 * D1: one schema holds the event log and every read model, so a command's
 * events, its state, its receipt and the `Entitlements` row a `check()` reads
 * are written by the same store.
 *
 * `now` is injected rather than read from the ambient clock, so a replay is
 * deterministic and a test can pin time.
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
