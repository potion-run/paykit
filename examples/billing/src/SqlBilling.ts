import * as Domain from "@alchemy.run/domain";
import { Model, PaykitHandlers } from "@potion.run/paykit";
import { CatalogGuardLive, catalogLayer, DevGuards } from "@potion.run/paykit";
import { d1Executor, type D1Like } from "@potion.run/paykit";
import { SqlBillingReadStore } from "@potion.run/paykit";
import { SqlEventLog } from "@potion.run/paykit";
import { SqlPlatform } from "@potion.run/paykit";
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

  const world = Layer.mergeAll(
    DevGuards,
    CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(Catalog))),
  ).pipe(
    Layer.provideMerge(Model.layer(PaykitHandlers.pipe(Layer.provide(reads)))),
    Layer.provideMerge(reads),
    Layer.provideMerge(Layer.succeed(Domain.Platform, platform)),
  );

  return { log, world: Layer.orDie(world) as Layer.Layer<any, never, never> };
};
