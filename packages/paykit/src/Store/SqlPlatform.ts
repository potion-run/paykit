import { consumerOf, type Plan } from "@alchemy.run/domain/Backfill";
import {
  type AggregateKit,
  type Delivery,
  type ModelHost,
  Platform,
  type ProjectionKit,
  type ProjectionStore,
  type ViewKit,
  type ViewStore,
} from "@alchemy.run/domain/Platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { asyncOf, type SqlError, type SqlExecutor } from "./Sql.ts";
import { type BindableAggregateStore, SqlAggregateStore } from "./SqlAggregateStore.ts";
import {
  SqlPolicyStore,
  SqlProjectionStore,
  SqlStreamStore,
  SqlViewStore,
} from "./SqlConsumers.ts";
import type { SqlEventLog } from "./SqlEventLog.ts";
import { BILLING_TABLES, tableName } from "./Tables.ts";
import { upsertRow } from "./Upsert.ts";

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

/** The generation a target id names: `view:Entitlements#2` is 2, no suffix is 0. */
const generationOf = (target: string): number => {
  const match = /[#@](\d+)$/.exec(target);

  return match === null ? 0 : Number(match[1]);
};

/** A stable description of what a consumer reads, so a changed plan is caught. */
const planSignature = (plan: Plan): string =>
  JSON.stringify({
    sources: [...(plan.sources ?? [])].sort(),
    singleSource: plan.singleSource,
    generations: Object.fromEntries(
      Object.entries(plan.generations ?? {}).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  });

/**
 * Host a model on SQL: every aggregate, view, policy, projection and stream
 * gets its rows in the same `billing_*` schema, and `billing_event` is the
 * only truth.
 *
 * The platform keeps every consumer across deploys, so it also owns their
 * history. `start` catches up each view and projection that is new — or whose
 * declared version (its generation) changed — from the event log. A view keyed
 * by the one aggregate it reads is filled by each key on first touch instead
 * (Domain's `catchUp`), so a version bump does not need a long deploy-time
 * scan. The generation is recorded in `billing_rm_backfill`, so a restart skips
 * a completed consumer and a changed plan without a version bump fails the
 * build instead of silently reading the wrong history.
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
  executor: SqlExecutor,
  log: SqlEventLog,
  options: SqlPlatformOptions,
): SqlModelHost => {
  const sql = asyncOf(executor);
  const shared = { now: options.now, pollMillis: options.pollMillis, schema: options.schema };
  const scope = { dialect: executor.dialect, schema: options.schema };
  const viewEntryTable = tableName(BILLING_TABLES.viewEntry, scope);
  const backfillTable = tableName(BILLING_TABLES.backfill, scope);

  // One model owns one database: the tables are keyed by entity name, not by
  // model, so a second model would share its aggregate's rows with the first.
  // Refuse rather than let two models silently read each other's events.
  let hosted: string | undefined;

  const aggregateNames = new Set<string>();
  const aggregateKits = new Map<string, AggregateKit>();
  const viewKits = new Map<string, ViewKit>();
  const viewStores = new Map<string, ViewStore>();
  const projectionKits = new Map<string, ProjectionKit>();
  const projectionStores = new Map<string, ProjectionStore>();
  let planOf: (target: string) => Plan | undefined = () => undefined;

  /** A source row in the shape `AggregateKit.history` reads from the log. */
  // SAFETY: the outbox row's delivery is JSON written by this platform; the consumer's schema owns the value.
  const storedEvents = (source: string, id: string) =>
    Effect.flatMap(log.events(source, id), (rows) =>
      Effect.forEach(
        rows,
        (row) =>
          Effect.sync(() => ({
            event: JSON.parse(row.event) as unknown,
            envelope: {
              id,
              stream: `${source}/${id}`,
              seq: row.seq,
              at: row.at,
              commandId: row.commandId,
              correlationId: row.commandId,
            },
          })),
        { concurrency: 1 },
      ),
    );

  /** A view source's entries for one key, in the generation it folded. */
  // SAFETY: the outbox row's delivery is JSON written by this platform; the consumer's schema owns the value.
  const viewEntries = (view: string, key: string, generation: number) =>
    Effect.map(
      sql.query<{
        seq: number | string;
        event: string;
        envelope: string;
        state: string;
      }>(
        `SELECT seq, event, envelope, state FROM ${viewEntryTable}
         WHERE view = ? AND key = ? AND generation = ? ORDER BY seq ASC`,
        [view, key, generation],
      ),
      (rows) =>
        rows.map((row) => ({
          seq: Number(row.seq),
          event: JSON.parse(row.event) as unknown,
          envelope: JSON.parse(row.envelope) as unknown,
          state: JSON.parse(row.state) as unknown,
        })),
    );

  /**
   * The keys a view source has. A view keyed by its one aggregate has one key
   * per instance of that aggregate; reading a key the source never had is an
   * empty fold, so a superset is safe. The keys are only an enumeration detail:
   * `history` decides which key each delivery belongs to.
   */
  const viewKeys = (view: string) =>
    Effect.gen(function* () {
      const kit = viewKits.get(view);

      const sources =
        kit === undefined
          ? []
          : (planOf(kit.target)?.sources ?? []).filter((source) => aggregateNames.has(source));

      const names = sources.length > 0 ? sources : [...aggregateNames];

      const accounts = yield* Effect.forEach(names, (name) => log.accounts(name), {
        concurrency: 1,
      });

      return [...new Set(accounts.flat())].sort();
    });

  /** Route every stored row of one source through a consumer's own code. */
  const sourceDeliveries = (
    target: string,
    source: string,
    kit: ViewKit | ProjectionKit,
  ): Effect.Effect<ReadonlyArray<Delivery>, SqlError> =>
    Effect.gen(function* () {
      if (aggregateNames.has(source)) {
        const ids = yield* log.accounts(source);

        const routed = yield* Effect.forEach(
          ids,
          (id) =>
            Effect.flatMap(storedEvents(source, id), (rows) =>
              kit.history(target, source, id, rows),
            ),
          { concurrency: 1 },
        );

        return routed.flatMap((rows) => rows.flatMap((row) => row.deliveries));
      }

      const view = viewKits.get(source);

      if (view === undefined) {
        return yield* Effect.die(`backfill source ${source} is not hosted by this model`);
      }

      const store = viewStores.get(source);

      if (store === undefined) {
        return yield* Effect.die(`backfill source ${source} has no store`);
      }

      const keys = yield* viewKeys(source);
      const routed: Array<Delivery> = [];

      for (const key of keys) {
        // A self-filling source (a rebuilt-in-place view) fills its key before
        // it answers; without this read the rows a consumer needs would not
        // exist yet.
        yield* store.read(key);
        const rows = yield* viewEntries(source, key, view.generation);

        if (rows.length === 0) continue;
        const history = yield* kit.history(target, source, key, rows);
        routed.push(...history.flatMap((row) => row.deliveries));
      }

      return routed;
    }).pipe(Effect.orDie);

  /** Replay one consumer's sources into its store, in event order. */
  const backfill = (target: string, plan: Plan) =>
    Effect.gen(function* () {
      const { kind, name } = consumerOf(target);
      const kit = kind === "view" ? viewKits.get(name) : projectionKits.get(name);

      if (kit === undefined) {
        return yield* Effect.die(`backfill target ${target} is not hosted by this model`);
      }

      const sources = plan.sources ?? [];
      const deliveries: Array<Delivery> = [];

      for (const source of sources) {
        deliveries.push(...(yield* sourceDeliveries(target, source, kit)));
      }

      deliveries.sort(
        (left, right) =>
          left.envelope.at - right.envelope.at ||
          (left.source < right.source ? -1 : left.source > right.source ? 1 : 0) ||
          left.seq - right.seq,
      );

      if (deliveries.length === 0) return;

      if (kind === "view") {
        const store = viewStores.get(name)!;
        const grouped = new Map<string, Array<Delivery>>();

        for (const delivery of deliveries) {
          const list = grouped.get(delivery.key);

          if (list === undefined) grouped.set(delivery.key, [delivery]);
          else list.push(delivery);
        }

        for (const [key, batch] of grouped) yield* store.receive(key, batch);

        return;
      }

      const store = projectionStores.get(name)!;
      yield* Effect.forEach(deliveries, (delivery) => store.receive(delivery), {
        concurrency: 1,
        discard: true,
      });
    });

  /** Deliver every committed outbox row still waiting, for any aggregate. */
  const drainPending = Effect.gen(function* () {
    while (true) {
      const pending = yield* log.pendingDeliveries(100);

      if (pending.length === 0) return;

      for (const row of pending) {
        const kit = aggregateKits.get(row.aggregate);

        if (kit === undefined) {
          return yield* Effect.die(`outbox row for ${row.aggregate}, which is not hosted`);
        }

        // SAFETY: the outbox row's delivery is JSON written by this platform; the consumer's schema owns the value.
        yield* kit.deliver(JSON.parse(row.delivery) as Delivery);
        yield* log.markDelivered(row.seq);
      }
    }
  }).pipe(Effect.orDie);

  const host = (_modelName: string): ModelHost => ({
    aggregate: (aggregate, kit) =>
      Effect.map(
        SqlAggregateStore(log, {
          aggregate: aggregate.aggregateName,
          now: options.now,
          ...(options.pollMillis === undefined ? {} : { pollMillis: options.pollMillis }),
        }),
        (store: BindableAggregateStore) => {
          aggregateNames.add(aggregate.aggregateName);
          aggregateKits.set(aggregate.aggregateName, kit);

          return store.bind(kit);
        },
      ),

    view: (view, kit) =>
      Effect.map(
        SqlViewStore(executor, {
          ...shared,
          name: view.viewName,
          history: storedEvents,
        }),
        (held) => {
          // SAFETY: the outbox row's delivery is JSON written by this platform; the consumer's schema owns the value.
          const store = held.bind(kit as ViewKit);
          // SAFETY: the outbox row's delivery is JSON written by this platform; the consumer's schema owns the value.
          viewKits.set(view.viewName, kit as ViewKit);
          viewStores.set(view.viewName, store);

          return store;
        },
      ),

    policy: (policy, kit) =>
      Effect.map(SqlPolicyStore(executor, { ...shared, name: policy.policyName }), (held) =>
        held.bind(kit),
      ),

    projection: (projection, kit) =>
      Effect.map(
        SqlProjectionStore(executor, {
          ...shared,
          name: projection.projectionName,
        }),
        (held) => {
          const store = held.bind(kit);
          projectionKits.set(projection.projectionName, kit);
          projectionStores.set(projection.projectionName, store);

          return store;
        },
      ),

    stream: (stream, kit) =>
      Effect.map(SqlStreamStore(executor, { ...shared, name: stream.streamName }), (held) =>
        held.bind(kit),
      ),

    start: (_targets, plansOfTarget, backfilled) =>
      Effect.gen(function* () {
        planOf = plansOfTarget;
        const inBackfill = new Set(backfilled);
        const viewTarget = new Map<string, string>();

        for (const target of backfilled) {
          const { kind, name } = consumerOf(target);

          if (kind === "view") viewTarget.set(name, target);
        }

        // A projection that reads a rebuilt view has to wait for that view's
        // history, or it would replay an empty source and record itself as
        // complete.
        const order: Array<string> = [];
        const visiting = new Set<string>();

        const visit = (target: string) => {
          if (order.includes(target) || visiting.has(target)) return;
          visiting.add(target);

          for (const source of plansOfTarget(target)?.sources ?? []) {
            const dependency = viewTarget.get(source);

            if (dependency !== undefined && inBackfill.has(dependency)) visit(dependency);
          }

          visiting.delete(target);
          order.push(target);
        };

        for (const target of backfilled) visit(target);

        for (const target of order) {
          const plan = plansOfTarget(target);

          if (plan === undefined) continue;
          const signature = planSignature(plan);

          const recorded = yield* sql.get<{ plan: string }>(
            `SELECT plan FROM ${backfillTable} WHERE consumer = ?`,
            [target],
          );

          if (recorded !== undefined) {
            if (recorded.plan === signature) continue;

            return yield* Effect.die(
              `consumer ${target} now reads ${JSON.stringify(plan.sources ?? [])}, but its recorded plan is different; bump the consumer's version so it is rebuilt`,
            );
          }

          yield* backfill(target, plan);
          yield* sql.write(
            upsertRow(
              executor.dialect,
              backfillTable,
              ["consumer", "generation", "plan", "completed_at"],
              ["consumer"],
            ),
            [target, generationOf(target), signature, options.now()],
          );
        }
        // Self-filling views are not in `backfill`; there is nothing to record:
        // each key answers only after it has read its own history.

        // A crash between a commit and its delivery leaves the outbox row. A
        // send drains it for its own account; this is the restart path, which
        // is what makes the at-least-once promise reach an account nobody
        // writes to again.
        yield* drainPending;
      }).pipe(Effect.orDie),

    history: (target) =>
      Effect.map(
        sql.get<{ one: number }>(`SELECT 1 AS one FROM ${backfillTable} WHERE consumer = ?`, [
          target,
        ]),
        (row) => ({ complete: row !== undefined }),
      ).pipe(Effect.orDie),
  });

  return {
    platform: Platform.of({
      model: ({ modelName }) =>
        Effect.suspend(() => {
          if (hosted !== undefined && hosted !== modelName) {
            return Effect.die(
              `SqlPlatform hosts one model per database: ${hosted} is already hosted, ${modelName} is not`,
            );
          }

          hosted = modelName;

          return Effect.succeed(host(modelName));
        }),
    }),
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
