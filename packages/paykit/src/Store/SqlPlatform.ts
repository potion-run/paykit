import {
  type AggregateKit,
  type ModelHost,
  Platform,
  type PolicyKit,
  type ProjectionKit,
  type StreamKit,
  type ViewKit,
} from "@alchemy.run/domain/Platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlExecutor } from "./Sql.ts";
import { SqlAggregateStore } from "./SqlAggregateStore.ts";
import {
  SqlPolicyStore,
  SqlProjectionStore,
  SqlStreamStore,
  SqlViewStore,
} from "./SqlConsumers.ts";
import type { SqlEventLog } from "./SqlEventLog.ts";

/** What a SQL platform needs to host a model. */
export interface SqlPlatformOptions {
  /** Epoch milliseconds, injected so no store has an ambient clock. */
  readonly now: () => number;
  /** The Postgres schema every `billing_*` table lives in. SQLite ignores it. */
  readonly schema?: string;
  /** How often a live read polls. */
  readonly pollMillis?: number;
}

/** A hosted model, and the log that is its truth. */
export interface SqlModelHost {
  /** The `Domain.Platform` to provide to `Model.layer`. */
  readonly platform: Platform["Service"];
  /** The durable event log the platform writes. */
  readonly log: SqlEventLog;
}

/**
 * Host a model on SQL: every aggregate, view, policy, projection and stream
 * gets its rows in the same `billing_*` schema, and `billing_event` is the
 * only truth.
 *
 * There is no backfill and no `start`: every consumer table is a fold, so a
 * consumer that needs rebuilding is rebuilt by dropping its `billing_rm_*`
 * table and replaying the log, which is a choice an operator makes rather than
 * something a deploy silently runs over a money database.
 *
 * ### Hosting paykit on SQLite
 * **Example:** The same model, a durable store
 * ```typescript
 * const log = Paykit.SqlEventLog(sql, { now: () => Date.now() });
 * const { platform } = Paykit.SqlPlatform(sql, log, { now: () => Date.now() });
 * const world = Paykit.Model.layer(Paykit.ModelHandlers).pipe(
 *   Layer.provide(Layer.succeed(Domain.Platform, platform)),
 * );
 * ```
 *
 * @primitive
 */
export const SqlPlatform = (
  sql: SqlExecutor,
  log: SqlEventLog,
  options: SqlPlatformOptions,
): SqlModelHost => {
  const shared = { now: options.now, pollMillis: options.pollMillis, schema: options.schema };

  // A store is named by the kernel's own name for the entity, not qualified by
  // the model: a receipt's `stream` (`Subscription/a1`) and a view's input
  // checkpoints are keyed by it, and `atLeast` waits on exactly that key. One
  // model owns one database, so there is nothing to disambiguate.
  const host = (_modelName: string): ModelHost => ({
    aggregate: (aggregate, kit) =>
      SqlAggregateStore(log, {
        aggregate: aggregate.aggregateName,
        now: options.now,
        ...(options.pollMillis === undefined ? {} : { pollMillis: options.pollMillis }),
      }).pipe(
        Effect.map((store) => {
          (store as unknown as { bind: (built: AggregateKit) => void }).bind?.(kit);
          return store;
        }),
      ),

    view: (view, kit) =>
      SqlViewStore(sql, { ...shared, name: view.viewName }).pipe(
        Effect.map((held) => {
          const bound = held.bind(kit as ViewKit);
          // A view keyed by its source reads that instance's history itself,
          // so the first read of a key covers the whole log without a backfill.
          return bound;
        }),
      ),

    policy: (policy, kit) =>
      SqlPolicyStore(sql, { ...shared, name: policy.policyName }).pipe(
        Effect.map((held) => held.bind(kit as PolicyKit)),
      ),

    projection: (projection, kit) =>
      SqlProjectionStore(sql, {
        ...shared,
        name: projection.projectionName,
      }).pipe(Effect.map((held) => held.bind(kit as ProjectionKit))),

    stream: (stream, kit) =>
      SqlStreamStore(sql, { ...shared, name: stream.streamName }).pipe(
        Effect.map((held) => held.bind(kit as StreamKit)),
      ),
  });

  return {
    platform: Platform.of({ model: ({ modelName }) => Effect.succeed(host(modelName)) }),
    log,
  };
};

/**
 * The platform as a Layer, merged with the log so a binding can read it.
 *
 * @layer
 */
export const layerSqlPlatform = (
  sql: SqlExecutor,
  log: SqlEventLog,
  options: SqlPlatformOptions,
): Layer.Layer<Platform> => Layer.succeed(Platform, SqlPlatform(sql, log, options).platform);
