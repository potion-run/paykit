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
 * The same world the other examples build, on MySQL: the SQL event log, the SQL
 * platform and the SQL read store. The executor is the only platform-specific
 * piece, which is what lets the deploy, the test and a host share this function.
 */
const mysqlWorld = (log: SqlEventLog, platform: Domain.Platform["Service"]) =>
  Paykit.world({
    ...billing,
    platform: Layer.succeed(Domain.Platform, platform),
    readStore: SqlBillingReadStore(log),
    guards: InsecureDevGuards,
  });

/** Everything a MySQL-hosted world provides. */
export type MySQLWorld = ReturnType<typeof mysqlWorld>;

/** What `billingOnMysql` gives back: the log, and the model hosted on it. */
export interface BillingOnMySQL {
  readonly log: SqlEventLog;
  readonly world: MySQLWorld;
}

/**
 * Host the billing model on MySQL. MySQL's namespace is the connection's
 * database, so no schema is passed: every table is quoted with backticks and
 * lives in the database the URL names.
 *
 * `now` is injected rather than read from the ambient clock, so a replay is
 * deterministic and a test can pin time.
 */
export const billingOnMysql = (
  sql: SqlExecutor,
  options: { readonly now: () => number },
): BillingOnMySQL => {
  const now = options.now;
  const log = SqlEventLog(sql, { now });
  const { platform } = SqlPlatform(sql, log, { now, pollMillis: 50 });

  return { log, world: mysqlWorld(log, platform) };
};
