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
  const outboxTable = tableName(BILLING_TABLES.outbox, scope);
  const stateTable = tableName(BILLING_TABLES.state, scope);

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
  // SAFETY: a stored event is JSON written by this platform; the consumer's schema owns the value.
  const storedEvents = (source: string, id: string) =>
    Effect.flatMap(log.events(source, id), (rows) =>
      // One step for the page: the decode is pure, so a row is not a fiber.
      Effect.sync(() =>
        rows.map((row) => ({
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

  /** The keys (source instances) a backfill source has, in a stable order. */
  const sourceKeys = (source: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.suspend(() => {
      if (aggregateNames.has(source)) return log.accounts(source);

      if (viewKits.has(source)) return viewKeys(source);

      return Effect.die(`backfill source ${source} is not hosted by this model`);
    });

  /**
   * The deliveries one source instance routes into `key`. An aggregate source
   * reads the instance named `key`; a view source reads that key's entries
   * (filling it first when it is self-filling). One instance's history, never a
   * source's whole log.
   */
  const keyDeliveries = (
    target: string,
    source: string,
    key: string,
    kit: ViewKit | ProjectionKit,
  ): Effect.Effect<ReadonlyArray<Delivery>, SqlError> =>
    Effect.gen(function* () {
      if (aggregateNames.has(source)) {
        const rows = yield* storedEvents(source, key);
        const history = yield* kit.history(target, source, key, rows);

        return history.flatMap((row) => row.deliveries);
      }

      const view = viewKits.get(source);

      if (view === undefined) {
        return yield* Effect.die(`backfill source ${source} is not hosted by this model`);
      }

      const store = viewStores.get(source);

      if (store === undefined) {
        return yield* Effect.die(`backfill source ${source} has no store`);
      }

      // A self-filling source (a rebuilt-in-place view) fills its key before
      // it answers; without this read the rows a consumer needs would not
      // exist yet.
      yield* store.read(key);
      const rows = yield* viewEntries(source, key, view.generation);

      if (rows.length === 0) return [];

      const history = yield* kit.history(target, source, key, rows);

      return history.flatMap((row) => row.deliveries);
    }).pipe(Effect.orDie);

  /** `(at, source, seq)`: the order a consumer folds history in. */
  const byEventOrder = (left: Delivery, right: Delivery): number =>
    left.envelope.at - right.envelope.at ||
    (left.source < right.source ? -1 : left.source > right.source ? 1 : 0) ||
    left.seq - right.seq;

  /**
   * Every delivery a consumer's sources route, in the global order, gathered
   * into one array. A projection reads across keys, so this order is part of
   * its fold: a projection's backfill holds its sources' history.
   */
  const sourceDeliveries = (
    target: string,
    sources: ReadonlyArray<string>,
    kit: ViewKit | ProjectionKit,
  ): Effect.Effect<Array<Delivery>, SqlError> =>
    Effect.gen(function* () {
      const deliveries: Array<Delivery> = [];

      for (const source of sources) {
        const keys = yield* sourceKeys(source);

        for (const key of keys) {
          for (const delivery of yield* keyDeliveries(target, source, key, kit)) {
            deliveries.push(delivery);
          }
        }
      }

      deliveries.sort(byEventOrder);

      return deliveries;
    });

  /** Replay one consumer's sources into its store, in event order. */
  const backfill = (target: string, plan: Plan) =>
    Effect.gen(function* () {
      const { kind, name } = consumerOf(target);
      const kit = kind === "view" ? viewKits.get(name) : projectionKits.get(name);

      if (kit === undefined) {
        return yield* Effect.die(`backfill target ${target} is not hosted by this model`);
      }

      const sources = plan.sources ?? [];

      if (kind === "view" && plan.singleSource) {
        // A view keyed by its aggregate folds one key independently: every
        // delivery it can receive belongs to that key, so the global
        // `(at, source, seq)` sort restricted to the key is the same order as
        // sorting only the key's deliveries. Folding key by key therefore
        // reproduces the global fold while holding one key's history.
        const store = viewStores.get(name)!;
        const keys = new Set<string>();

        for (const source of sources) {
          for (const key of yield* sourceKeys(source)) keys.add(key);
        }

        for (const key of [...keys].sort()) {
          const batch: Array<Delivery> = [];

          for (const source of sources) {
            for (const delivery of yield* keyDeliveries(target, source, key, kit)) {
              batch.push(delivery);
            }
          }

          if (batch.length === 0) continue;
          batch.sort(byEventOrder);
          yield* store.receive(key, batch);
        }

        return;
      }

      const deliveries = yield* sourceDeliveries(target, sources, kit);

      if (deliveries.length === 0) return;

      if (kind === "view") {
        // A view whose keys merge several sources has no per-key index to read
        // one key's deliveries from; it keeps the global order, and its
        // backfill is bounded by its sources' history rather than one key's.
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

      // A projection reads across keys, so its `(at, source, seq)` order is
      // part of the fold. Its backfill holds its sources' history; a view's is
      // bounded by one key.
      const store = projectionStores.get(name)!;
      yield* Effect.forEach(deliveries, (delivery) => store.receive(delivery), {
        concurrency: 1,
        discard: true,
      });
    });

  /**
   * Deliver every waiting row of every hosted aggregate. The page is filtered
   * by aggregate, so an aggregate this host does not know never fills it and
   * never blocks the rows it does know; every page strictly shrinks the rows
   * left for that aggregate.
   */
  const drainHosted = Effect.gen(function* () {
    const page = 100;

    for (const aggregate of aggregateKits.keys()) {
      while (true) {
        const pending = yield* log.pendingDeliveries(page, { aggregate });

        if (pending.length === 0) break;

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
    }
  });

  /** The unhosted row a deploy cannot deliver, with what is still waiting. */
  const failUnhosted = (aggregate: string) =>
    Effect.gen(function* () {
      const counted = yield* sql.get<{ remaining: number | string }>(
        `SELECT COUNT(*) AS remaining FROM ${outboxTable} WHERE delivered_at IS NULL`,
      );

      const remaining = Number(counted?.remaining ?? 0);

      return yield* Effect.die(
        `outbox holds ${remaining} undelivered row(s); the first is for ${aggregate}, which this model does not host`,
      );
    });

  /**
   * Deliver every committed outbox row still waiting, retrying while a
   * concurrent writer commits for a hosted aggregate after that aggregate's
   * turn in a pass. The bound keeps a writer that commits forever from spinning
   * the deploy; after it, those rows are left to the writers' own drains.
   */
  const drainPending = Effect.gen(function* () {
    const page = 100;

    for (let pass = 0; pass < aggregateKits.size + 8; pass += 1) {
      yield* drainHosted;

      const first = (yield* log.pendingDeliveries(page))[0];

      if (first === undefined) return;

      if (!aggregateKits.has(first.aggregate)) {
        return yield* failUnhosted(first.aggregate);
      }
    }
  }).pipe(Effect.orDie);

  const host = (_modelName: string): ModelHost => ({
    aggregate: (aggregate, kit) =>
      Effect.map(
        SqlAggregateStore(log, {
          aggregate: aggregate.aggregateName,
          now: options.now,
          // The version column alone, so `changes` does not read and re-parse
          // the whole state on every poll of an unchanged instance.
          versionOf: (id: string) =>
            Effect.map(
              sql.get<{ version: number | string }>(
                `SELECT version FROM ${stateTable} WHERE aggregate = ? AND account = ?`,
                [aggregate.aggregateName, id],
              ),
              (row) => (row === undefined ? 0 : Number(row.version)),
            ),
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
        const ordered = new Set<string>();
        const visiting = new Set<string>();

        const visit = (target: string) => {
          if (ordered.has(target) || visiting.has(target)) return;
          visiting.add(target);

          for (const source of plansOfTarget(target)?.sources ?? []) {
            const dependency = viewTarget.get(source);

            if (dependency !== undefined && inBackfill.has(dependency)) visit(dependency);
          }

          visiting.delete(target);
          ordered.add(target);
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
