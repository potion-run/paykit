import * as Domain from "@alchemy.run/domain";
import {
  type D1Like,
  d1Executor,
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
 * The same world a memory host builds, on a database: the read store is the SQL
 * one and the platform is the SQL host, so the Worker, its routes and the tests
 * all see one graph.
 */
const sqlWorld = (log: SqlEventLog, platform: Domain.Platform["Service"]) =>
  Paykit.world({
    ...billing,
    platform: Layer.succeed(Domain.Platform, platform),
    readStore: SqlBillingReadStore(log),
    guards: InsecureDevGuards,
  });

/** Everything a SQL-hosted world provides, and nothing it does not. */
export type SqlWorld = ReturnType<typeof sqlWorld>;

/** What `billingOn` gives back: a database, and the model hosted on it. */
export interface BillingOnSql {
  readonly log: SqlEventLog;
  /** Everything the Apis need: the model, the catalog, the guards and the platform. */
  readonly world: SqlWorld;
}

/**
 * The model on the database: one schema holds the event log and every read
 * model, so a command's events, its state, its receipt and the `Entitlements`
 * row a `check()` reads are written by the same store.
 *
 * A `D1Like` is the only thing this needs from the platform, which is what lets
 * the same function serve a Worker and a test: pass the binding in a deployed
 * Worker, and a SQLite driver in a test.
 *
 * `now` is injected rather than read from the ambient clock, so a replay is
 * deterministic and a test can pin time.
 */
export const billingOn = (
  sql: SqlExecutor,
  options: { readonly now?: () => number } = {},
): BillingOnSql => {
  const now = options.now ?? (() => Date.now());
  const log = SqlEventLog(sql, { now });
  const { platform } = SqlPlatform(sql, log, { now, pollMillis: 50 });

  return { log, world: sqlWorld(log, platform) };
};

/**
 * The model on a D1-shaped target, which is what a test passes. A deployed
 * Worker reads the executor from `Paykit.Database` instead, so the platform
 * binding is resolved once, in the port.
 */
export const billingOnSql = (
  d1: D1Like,
  options: { readonly now?: () => number } = {},
): BillingOnSql => billingOn(d1Executor(d1), options);
