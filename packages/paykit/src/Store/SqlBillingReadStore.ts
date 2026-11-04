import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BillingReadStore,
  DEFAULT_PAGE,
  MAX_PAGE,
  type BillingReadQuery,
} from "../BillingReadStore.ts";
import type { SqlEventLog } from "./SqlEventLog.ts";

/**
 * The projection's port, backed by the same database as the event log: one
 * schema holds the truth and its read models, so a dashboard, the edge read
 * path and `doctor` all see the same rows without a second store to drift.
 *
 * `list` pushes the filter, the cursor and the limit into SQL, so a page costs
 * a page rather than the whole projection.
 *
 * An infrastructure failure is a defect: the port declares no error channel,
 * and a read model that cannot be read must not look like an empty result.
 *
 * ### Hosting the read models where the truth lives
 * **Example:** One schema, one store
 * ```typescript
 * const log = Paykit.SqlEventLog(sql, { now: () => Date.now() });
 * const reads = Paykit.SqlBillingReadStore(log);
 * const world = Paykit.Model.layer(
 *   Paykit.ModelHandlers.pipe(Layer.provide(reads)),
 * ).pipe(Layer.provideMerge(reads), Layer.provide(platform));
 * ```
 *
 * @layer
 */
export const SqlBillingReadStore = (log: SqlEventLog): Layer.Layer<BillingReadStore> =>
  Layer.succeed(BillingReadStore, {
    upsert: (row) => log.upsertReadModel(row).pipe(Effect.orDie),
    get: (account) => log.readModel(account).pipe(Effect.orDie),
    list: (query?: BillingReadQuery) => log.readModelPage(query).pipe(Effect.orDie),
  });

export { DEFAULT_PAGE, MAX_PAGE };
