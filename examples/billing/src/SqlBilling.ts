import * as Domain from "@alchemy.run/domain";
import {
  DevGuards,
  d1Executor,
  type D1Like,
  paykitWorld,
  SqlBillingReadStore,
  SqlEventLog,
  SqlPlatform,
} from "@potion.run/paykit";
import * as Layer from "effect/Layer";
import { Catalog } from "./Billing.ts";

/** What `billingOnSql` gives back: a database, and the model hosted on it. */
export interface BillingOnSql {
  readonly log: SqlEventLog;
  /**
   * Everything the Apis need: the model, the catalog, the guards and the
   * platform. `any` in the output channel on purpose — it is the whole
   * environment, and naming it would mean restating the model's requirements.
   */
  readonly world: Layer.Layer<any, never, never>;
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
export const billingOnSql = (
  d1: D1Like,
  options: { readonly now?: () => number } = {},
): BillingOnSql => {
  const now = options.now ?? (() => Date.now());
  const sql = d1Executor(d1);
  const log = SqlEventLog(sql, { now });
  const reads = SqlBillingReadStore(log);
  const { platform } = SqlPlatform(sql, log, { now, pollMillis: 50 });

  // The same world a memory deployment builds, on this database: the read
  // store is the SQL one and the platform is the SQL host, so the Worker, its
  // routes and the tests all see one graph.
  const world = paykitWorld({
    catalog: Catalog,
    platform: Layer.succeed(Domain.Platform, platform),
    readStore: reads,
    guards: DevGuards,
  });

  return { log, world: Layer.orDie(world) as Layer.Layer<any, never, never> };
};
