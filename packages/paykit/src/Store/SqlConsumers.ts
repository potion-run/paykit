import type {
  Accepted,
  Delivery,
  EnvelopeJson,
  PolicyKit,
  PolicyStore,
  ProjectionKit,
  ProjectionStore,
  StreamEntry,
  StreamKit,
  StreamMeta,
  StreamStore,
  StreamWrite,
  ViewEntry,
  ViewKit,
  ViewSnapshot,
  ViewStore,
} from "@alchemy.run/domain/Platform";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  asyncOf,
  type SqlAsync,
  type SqlDialect,
  type SqlError,
  type SqlExecutor,
  type SqlValue,
} from "./Sql.ts";
import { BILLING_TABLES, tableName, type TableScope } from "./Tables.ts";
import { insertIgnoring, upsertRow } from "./Upsert.ts";

/** What every consumer store needs beyond the executor. */
export interface SqlConsumerOptions {
  /** The consumer's name, as the model declares it. */
  readonly name: string;
  /** Epoch milliseconds, injected so no store has an ambient clock. */
  readonly now: () => number;
  /** How often a live read polls. */
  readonly pollMillis?: number;
  /** The Postgres schema. SQLite ignores it. */
  readonly schema?: string;
  /**
   * The stored rows of one source instance, for a view that fills its own keys.
   * Only a view keyed by the one aggregate it reads receives `catchUp`, and its
   * source is that aggregate, so the platform only has to answer for an
   * aggregate instance's events.
   */
  readonly history?: (
    source: string,
    id: string,
  ) => Effect.Effect<ReadonlyArray<unknown>, SqlError>;
}

const DEFAULT_POLL = 250;

const parse = (json: string | null): unknown => (json === null ? null : JSON.parse(json));

const poll = (interval: number) => Stream.tick(Duration.millis(interval));

const insertIgnore = (dialect: SqlDialect, table: string, names: ReadonlyArray<string>): string =>
  insertIgnoring(dialect, table, names);

/** Upsert one row by its primary key, spelled for the target's dialect. */
const upsert = (
  dialect: SqlDialect,
  table: string,
  names: ReadonlyArray<string>,
  key: ReadonlyArray<string>,
): string => upsertRow(dialect, table, names, key);

const scopeOf = (options: SqlConsumerOptions, dialect: SqlDialect): TableScope => ({
  dialect,
  schema: options.schema,
});

/**
 * A view's durable state: its snapshot, the entries it emitted and the input
 * log it dedupes by. Every row is a fold of `billing_event`, so dropping the
 * table and replaying the log is always allowed.
 *
 * `receive` drops a delivery already in the input log by `(source, seq)`,
 * applies the rest through `kit.apply`, writes the snapshot, the entries and
 * the input rows in one `atomic` unit, then delivers downstream — so a crash
 * between the write and the delivery replays rather than skips.
 *
 * @primitive
 */
export const SqlViewStore = (
  executor: SqlExecutor,
  options: SqlConsumerOptions,
): Effect.Effect<{ store: ViewStore; bind: (kit: ViewKit) => ViewStore }> =>
  Effect.sync(() => {
    const sql: SqlAsync = asyncOf(executor);
    const table = (logical: string) => tableName(logical, scopeOf(options, executor.dialect));
    const state = table(BILLING_TABLES.viewState);
    const entry = table(BILLING_TABLES.viewEntry);
    const input = table(BILLING_TABLES.viewInput);
    const outbox = table(BILLING_TABLES.viewOutbox);
    const pollMillis = options.pollMillis ?? DEFAULT_POLL;
    const view = options.name;

    // A key's fold is single-writer. The lock also keeps a lazy key's catch-up
    // from racing the live delivery that happens to arrive while it reads its
    // source: both would read the same snapshot and the later write would drop
    // the other's events.
    const locks = new Map<string, Semaphore.Semaphore>();

    const lockFor = (key: string): Semaphore.Semaphore => {
      const found = locks.get(key);

      if (found !== undefined) return found;
      const made = Semaphore.makeUnsafe(1);
      locks.set(key, made);

      return made;
    };

    const withKey = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
      lockFor(key).withPermits(1)(effect);

    /** A key whose catch-up this process has already performed. */
    const caughtUp = new Set<string>();

    const storedGeneration = (key: string) =>
      Effect.map(
        sql.get<{ generation: number | string }>(
          `SELECT generation FROM ${state} WHERE view = ? AND key = ?`,
          [view, key],
        ),
        (row) => (row === undefined ? undefined : Number(row.generation)),
      );

    const readSnapshot = (key: string, generation: number) =>
      Effect.map(
        sql.get<{
          generation: number | string;
          version: number | string;
          seq: number | string;
          checkpoints: string;
          state: string | null;
        }>(
          `SELECT generation, version, seq, checkpoints, state FROM ${state} WHERE view = ? AND key = ?`,
          [view, key],
        ),
        (row): ViewSnapshot => {
          // A key built by an earlier generation starts over: its rows describe
          // a fold this code no longer produces.
          if (row === undefined || Number(row.generation) !== generation) {
            return { state: null, version: 0, checkpoints: {}, seq: 0, generation };
          }

          // SAFETY: the row's text is decoded by the consumer's schema; the kernel's generics are erased at this store boundary.
          return {
            state: parse(row.state) as never,
            version: Number(row.version),
            checkpoints: JSON.parse(row.checkpoints) as never,
            seq: Number(row.seq),
            generation,
          };
        },
      );

    const alreadyApplied = (key: string, delivery: Delivery, generation: number) =>
      Effect.map(
        sql.get<{ one: number }>(
          `SELECT 1 AS one FROM ${input} WHERE view = ? AND key = ? AND source = ? AND source_seq = ? AND generation = ?`,
          [view, key, delivery.source, delivery.seq, generation],
        ),
        (row) => row !== undefined,
      );

    const write = (
      key: string,
      before: ViewSnapshot,
      after: ViewSnapshot,
      entries: ReadonlyArray<ViewEntry>,
      applied: ReadonlyArray<Delivery>,
      downstream: ReadonlyArray<Delivery>,
      generation: number,
    ) =>
      sql.atomic(
        Effect.gen(function* () {
          // A rebuilt key starts from an empty fold. Entries and inputs written
          // by the previous generation are no longer part of it, so remove them
          // in the same unit that writes the first new row. Without this a
          // generation that emits fewer entries than its predecessor would keep
          // serving the tail of the old one.
          const previous = yield* storedGeneration(key);
          yield* sql.write(`DELETE FROM ${entry} WHERE view = ? AND key = ? AND generation <> ?`, [
            view,
            key,
            generation,
          ]);
          yield* sql.write(`DELETE FROM ${input} WHERE view = ? AND key = ? AND generation <> ?`, [
            view,
            key,
            generation,
          ]);

          if (previous !== undefined && previous !== generation) {
            // A pending downstream delivery from the old fold would describe an
            // entry the new generation no longer has. Drop it; the rebuild
            // emits its own.
            yield* sql.write(`DELETE FROM ${outbox} WHERE view = ? AND key = ?`, [view, key]);
          }

          for (const delivery of applied) {
            yield* sql.write(
              insertIgnore(executor.dialect, input, [
                "view",
                "key",
                "source",
                "source_seq",
                "generation",
              ]),
              [view, key, delivery.source, delivery.seq, generation],
            );
          }

          yield* sql.write(
            upsert(
              executor.dialect,
              state,
              ["view", "key", "generation", "version", "seq", "checkpoints", "state"],
              ["view", "key"],
            ),
            [
              view,
              key,
              generation,
              after.version,
              after.seq,
              JSON.stringify(after.checkpoints),
              before.state === null && after.state === null ? null : JSON.stringify(after.state),
            ],
          );

          for (const emitted of entries) {
            yield* sql.write(
              upsert(
                executor.dialect,
                entry,
                ["view", "key", "generation", "seq", "event", "envelope", "state"],
                ["view", "key", "seq"],
              ),
              [
                view,
                key,
                generation,
                emitted.seq,
                JSON.stringify(emitted.event),
                JSON.stringify(emitted.envelope),
                JSON.stringify(emitted.state),
              ],
            );
          }

          // The deliveries this commit emits are in the same unit as the
          // entries that produced them. A retry of the *input* delivery will
          // not produce them again, so they must survive the process.
          for (const delivery of downstream) {
            yield* sql.write(
              `INSERT INTO ${outbox} (view, key, entry_seq, delivery) VALUES (?, ?, ?, ?)`,
              [view, key, after.seq, JSON.stringify(delivery)],
            );
          }
        }),
      );

    let kit: ViewKit | undefined;

    // SAFETY: the row's text is decoded by the consumer's schema; the kernel's generics are erased at this store boundary.
    const entries = (key: string, generation: number, after?: number) =>
      Effect.map(
        sql.query<{
          seq: number | string;
          event: string;
          envelope: string;
          state: string;
        }>(
          after === undefined
            ? `SELECT seq, event, envelope, state FROM ${entry} WHERE view = ? AND key = ? AND generation = ? ORDER BY seq ASC`
            : `SELECT seq, event, envelope, state FROM ${entry} WHERE view = ? AND key = ? AND generation = ? AND seq > ? ORDER BY seq ASC`,
          after === undefined ? [view, key, generation] : [view, key, generation, after],
        ),
        (rows) =>
          rows.map((row): ViewEntry => ({
            seq: Number(row.seq),
            event: parse(row.event) as never,
            envelope: parse(row.envelope) as never,
            state: parse(row.state) as never,
          })),
      );

    /** Apply deliveries to one key, deduping against its committed input log. */
    const applyBatch = (key: string, deliveries: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        const bound = kit;

        if (bound === undefined) return yield* Effect.die("view store used before it was built");
        const generation = bound.generation;

        // A delivery routed to an earlier generation belongs to a rebuild that
        // no longer exists. Absent means generation 0, not "any generation":
        // a stale row committed before a version bump carries no suffix and
        // must not be folded into the rebuilt fold.
        const matching = deliveries.filter(
          (delivery) => (delivery.target.generation ?? 0) === generation,
        );

        if (matching.length === 0) return;
        const snapshot = yield* readSnapshot(key, generation);
        // Dedupe before applying: at-least-once delivery means the same event
        // can arrive twice, and a view that applied both would double it. The
        // committed input log answers for earlier batches; a batch can also
        // carry the same delivery twice, which no row has recorded yet.
        const fresh: Array<Delivery> = [];
        const seen = new Set<string>();

        for (const delivery of matching) {
          const identity = `${delivery.source}:${delivery.seq}`;

          if (seen.has(identity)) continue;

          if (yield* alreadyApplied(key, delivery, generation)) continue;
          seen.add(identity);
          fresh.push(delivery);
        }

        if (fresh.length === 0) {
          // The input was already applied, but its downstream deliveries may
          // still be pending from a crash after the commit. Finish them.
          yield* drainOutbox(key);

          return;
        }

        const applied = yield* bound.apply(key, snapshot, fresh);

        if (applied.changed) {
          yield* write(
            key,
            snapshot,
            applied.snapshot,
            applied.entries,
            fresh,
            applied.downstream,
            generation,
          );
        }

        yield* drainOutbox(key);
      }).pipe(Effect.orDie);

    /** Deliver what a committed fold emitted, then remove it from the outbox. */
    const drainOutbox = (key: string) =>
      Effect.gen(function* () {
        const bound = kit;

        if (bound === undefined) return yield* Effect.die("view store used before it was built");

        while (true) {
          const pending = yield* sql.query<{ seq: number | string; delivery: string }>(
            `SELECT seq, delivery FROM ${outbox}
             WHERE view = ? AND key = ? AND delivered_at IS NULL ORDER BY seq ASC LIMIT 100`,
            [view, key],
          );

          if (pending.length === 0) return;

          for (const row of pending) {
            // SAFETY: the row's text is decoded by the consumer's schema; the kernel's generics are erased at this store boundary.
            yield* bound.deliver(JSON.parse(row.delivery) as Delivery);
            // After the target accepted it. A crash before this line redelivers
            // a delivery the target dedupes by `(source, seq)`.
            yield* sql.write(`DELETE FROM ${outbox} WHERE seq = ?`, [row.seq]);
          }
        }
      }).pipe(Effect.orDie);

    /**
     * A view keyed by its one aggregate fills each key itself before answering
     * (a lazy view, or a view whose version was bumped and is rebuilt in place).
     * Its source rows are read from the log; `kit.history` routes them to the
     * key exactly as a rebuild would.
     */
    const ensureCaughtUp = (key: string) =>
      Effect.gen(function* () {
        const bound = kit;

        if (bound === undefined) return yield* Effect.die("view store used before it was built");
        const catchUp = bound.catchUp;

        if (catchUp === undefined) return;
        const marker = `${bound.generation}:${key}`;

        if (caughtUp.has(marker)) return;

        const generation = bound.generation;

        if ((yield* storedGeneration(key)) === generation) {
          const snapshot = yield* readSnapshot(key, generation);

          if (snapshot.version > 0) {
            caughtUp.add(marker);

            return;
          }
        }

        const rows =
          options.history === undefined ? [] : yield* options.history(catchUp.source, key);

        if (rows.length > 0) {
          const routed = yield* bound.history(bound.target, catchUp.source, key, rows);
          yield* applyBatch(
            key,
            routed.flatMap((row) => row.deliveries),
          );
        }

        caughtUp.add(marker);
      }).pipe(Effect.orDie);

    const store: ViewStore = {
      receive: (key, deliveries) =>
        withKey(
          key,
          Effect.gen(function* () {
            yield* ensureCaughtUp(key);
            yield* applyBatch(key, deliveries);
          }),
        ),

      read: (key) =>
        withKey(
          key,
          Effect.gen(function* () {
            const bound = kit;

            if (bound === undefined)
              return yield* Effect.die("view store used before it was built");
            yield* ensureCaughtUp(key);
            // A read makes progress on anything a crash left in the outbox,
            // so a key nobody writes to again is not stuck waiting for a send.
            yield* drainOutbox(key);

            return yield* readSnapshot(key, bound.generation);
          }),
        ).pipe(Effect.orDie),

      changes: (key) =>
        poll(pollMillis).pipe(
          Stream.mapEffect(() =>
            withKey(
              key,
              Effect.gen(function* () {
                const bound = kit;

                if (bound === undefined)
                  return yield* Effect.die("view store used before it was built");
                yield* ensureCaughtUp(key);

                return yield* readSnapshot(key, bound.generation);
              }),
            ),
          ),
          Stream.changesWith((left, right) => left.version === right.version),
          Stream.orDie,
        ),

      list: (key) =>
        withKey(
          key,
          Effect.gen(function* () {
            const bound = kit;

            if (bound === undefined)
              return yield* Effect.die("view store used before it was built");
            yield* ensureCaughtUp(key);
            yield* drainOutbox(key);

            return yield* entries(key, bound.generation);
          }),
        ).pipe(Effect.orDie),

      tail: (key, after) => {
        let seen = after;

        return Stream.fromEffect(
          withKey(
            key,
            Effect.gen(function* () {
              const bound = kit;

              if (bound === undefined)
                return yield* Effect.die("view store used before it was built");
              yield* ensureCaughtUp(key);
            }),
          ),
        ).pipe(
          Stream.flatMap(() =>
            poll(pollMillis).pipe(
              Stream.mapEffect(() =>
                Effect.gen(function* () {
                  const bound = kit;

                  if (bound === undefined)
                    return yield* Effect.die("view store used before it was built");
                  const rows = yield* entries(key, bound.generation, seen);

                  if (rows.length > 0) seen = rows[rows.length - 1]!.seq;

                  return rows;
                }),
              ),
              Stream.flatMap((rows) => Stream.fromIterable(rows)),
              Stream.orDie,
            ),
          ),
        );
      },
    };

    return {
      store,
      bind: (built: ViewKit) => {
        kit = built;

        return store;
      },
    };
  });

export const SqlProjectionStore = (
  executor: SqlExecutor,
  options: SqlConsumerOptions,
): Effect.Effect<{ store: ProjectionStore; bind: (kit: ProjectionKit) => ProjectionStore }> =>
  Effect.sync(() => {
    const sql: SqlAsync = asyncOf(executor);
    const table = (logical: string) => tableName(logical, scopeOf(options, executor.dialect));
    const input = table(BILLING_TABLES.projectionInput);
    const cursors = table(BILLING_TABLES.projectionCursor);
    const projection = options.name;

    let kit: ProjectionKit | undefined;

    const drain = (key: string) =>
      Effect.gen(function* () {
        const bound = kit;

        if (bound === undefined) {
          return yield* Effect.die("projection store used before it was built");
        }

        // SAFETY: the row's text is decoded by the consumer's schema; the kernel's generics are erased at this store boundary.
        const pending = yield* Effect.map(
          sql.query<{
            position: number | string;
            delivery: string;
            accepted_at: number | string;
          }>(
            `SELECT position, delivery, accepted_at FROM ${input}
             WHERE projection = ? AND key = ? AND generation = ? AND processed_at IS NULL ORDER BY position ASC`,
            [projection, key, bound.generation],
          ),
          (rows) =>
            rows.map((row): Accepted => ({
              position: Number(row.position),
              at: Number(row.accepted_at),
              delivery: parse(row.delivery) as never,
            })),
        );

        if (pending.length === 0) return;
        yield* bound.run(key, pending);
        const last = pending[pending.length - 1]!.position;
        yield* sql.atomic(
          Effect.gen(function* () {
            yield* sql.write(
              upsert(
                executor.dialect,
                cursors,
                ["projection", "key", "position"],
                ["projection", "key"],
              ),
              [projection, key, last],
            );
            yield* sql.write(
              `UPDATE ${input} SET processed_at = ? WHERE projection = ? AND key = ? AND position <= ?`,
              [options.now(), projection, key, last],
            );
          }),
        );
      });

    const store: ProjectionStore = {
      receive: (delivery) =>
        Effect.gen(function* () {
          const bound = kit;

          if (bound === undefined) {
            return yield* Effect.die("projection store used before it was built");
          }

          // A delivery for another generation's rebuild does not belong here.
          // Absent is generation 0, so a stale delivery from before a version
          // bump is dropped rather than appended to the new log.
          if ((delivery.target.generation ?? 0) !== bound.generation) {
            return;
          }

          yield* sql.atomic(
            Effect.gen(function* () {
              // A rebuilt projection starts a new input log. The old rows and
              // cursor describe a fold this code no longer produces, and the
              // primary key would drop the new generation's delivery for the
              // same `(source, seq)` as a duplicate.
              const existing = yield* sql.get<{ generation: number | string }>(
                `SELECT generation FROM ${input} WHERE projection = ? AND key = ? LIMIT 1`,
                [projection, delivery.key],
              );

              if (existing !== undefined && Number(existing.generation) !== bound.generation) {
                yield* sql.write(`DELETE FROM ${input} WHERE projection = ? AND key = ?`, [
                  projection,
                  delivery.key,
                ]);
                yield* sql.write(`DELETE FROM ${cursors} WHERE projection = ? AND key = ?`, [
                  projection,
                  delivery.key,
                ]);
              }

              const last = yield* sql.get<{ position: number | string }>(
                `SELECT COALESCE(MAX(position), 0) AS position FROM ${input} WHERE projection = ? AND key = ?`,
                [projection, delivery.key],
              );

              const next = Number(last?.position ?? 0) + 1;
              // SAFETY: the row's text is decoded by the consumer's schema; the kernel's generics are erased at this store boundary.
              yield* sql.write(
                insertIgnore(executor.dialect, input, [
                  "projection",
                  "key",
                  "source",
                  "source_seq",
                  "generation",
                  "position",
                  "delivery",
                  "accepted_at",
                ]),
                [
                  projection,
                  delivery.key,
                  delivery.source,
                  delivery.seq,
                  bound.generation,
                  next,
                  JSON.stringify(delivery),
                  options.now() as SqlValue,
                ],
              );
            }),
          );
          yield* drain(delivery.key);
        }).pipe(Effect.orDie),

      // What reached the handler, per source stream: the highest `source_seq`
      // whose row is marked processed in the current generation.
      checkpoints: (key) =>
        Effect.gen(function* () {
          const bound = kit;

          if (bound === undefined) {
            return yield* Effect.die("projection store used before it was built");
          }

          const rows = yield* sql.query<{ source: string; seq: number | string }>(
            `SELECT source, MAX(source_seq) AS seq FROM ${input}
             WHERE projection = ? AND key = ? AND generation = ? AND processed_at IS NOT NULL GROUP BY source`,
            [projection, key, bound.generation],
          );

          // SAFETY: the row's text is decoded by the consumer's schema; the kernel's generics are erased at this store boundary.
          return Object.fromEntries(rows.map((row) => [row.source, Number(row.seq)])) as never;
        }).pipe(Effect.orDie),
    };

    return {
      store,
      bind: (built: ProjectionKit) => {
        kit = built;

        return store;
      },
    };
  });

/**
 * A policy's dedupe log. A policy hears every event it is responsible for, at
 * least once and in order per key; this row is what makes the second delivery
 * of one event a no-op instead of a second charge.
 *
 * The handler runs before the row is written, so a crash between them replays
 * the policy — which is safe because every command it sends carries its own
 * command id.
 *
 * @primitive
 */
export const SqlPolicyStore = (
  executor: SqlExecutor,
  options: SqlConsumerOptions,
): Effect.Effect<{ store: PolicyStore; bind: (kit: PolicyKit) => PolicyStore }> =>
  Effect.sync(() => {
    const sql: SqlAsync = asyncOf(executor);
    const seen = tableName(BILLING_TABLES.policySeen, scopeOf(options, executor.dialect));
    const policy = options.name;

    let kit: PolicyKit | undefined;

    const store: PolicyStore = {
      receive: (delivery) =>
        Effect.gen(function* () {
          const bound = kit;

          if (bound === undefined)
            return yield* Effect.die("policy store used before it was built");

          const already = yield* sql.get<{ one: number }>(
            `SELECT 1 AS one FROM ${seen} WHERE policy = ? AND key = ? AND source = ? AND source_seq = ?`,
            [policy, delivery.key, delivery.source, delivery.seq],
          );

          if (already !== undefined) return;
          yield* bound.run(delivery);
          yield* sql.write(
            insertIgnore(executor.dialect, seen, ["policy", "key", "source", "source_seq"]),
            [policy, delivery.key, delivery.source, delivery.seq],
          );
        }).pipe(Effect.orDie),
    };

    return {
      store,
      bind: (built: PolicyKit) => {
        kit = built;

        return store;
      },
    };
  });

const envelopeOf = (write: StreamWrite): EnvelopeJson => ({
  id: write.commandId,
  stream: write.source,
  seq: write.sourceSeq,
  at: write.at,
  commandId: write.commandId,
  correlationId: write.commandId,
});

/**
 * A keyed, append-only stream. A write whose `origin` is not after the last
 * applied one is a repeat and is dropped, which is what makes a stream safe to
 * feed from an at-least-once producer.
 *
 * @primitive
 */
export const SqlStreamStore = (
  executor: SqlExecutor,
  options: SqlConsumerOptions,
): Effect.Effect<{ store: StreamStore; bind: (kit: StreamKit) => StreamStore }> =>
  Effect.sync(() => {
    const sql: SqlAsync = asyncOf(executor);
    const table = (logical: string) => tableName(logical, scopeOf(options, executor.dialect));
    const metaTable = table(BILLING_TABLES.streamMeta);
    const entryTable = table(BILLING_TABLES.streamEntry);
    const pollMillis = options.pollMillis ?? DEFAULT_POLL;
    const stream = options.name;

    // SAFETY: the row's text is decoded by the consumer's schema; the kernel's generics are erased at this store boundary.
    const read = (key: string) =>
      Effect.map(
        sql.get<{
          seq: number | string;
          checkpoints: string;
          origin_a: number | string;
          origin_b: number | string;
        }>(
          `SELECT seq, checkpoints, origin_a, origin_b FROM ${metaTable} WHERE stream = ? AND key = ?`,
          [stream, key],
        ),
        (row): StreamMeta =>
          row === undefined
            ? { seq: 0, checkpoints: {}, origin: [0, 0] }
            : {
                seq: Number(row.seq),
                checkpoints: JSON.parse(row.checkpoints) as never,
                origin: [Number(row.origin_a), Number(row.origin_b)],
              },
      );

    const writeMeta = (key: string, meta: StreamMeta) =>
      sql.write(
        upsert(
          executor.dialect,
          metaTable,
          ["stream", "key", "seq", "checkpoints", "origin_a", "origin_b"],
          ["stream", "key"],
        ),
        [stream, key, meta.seq, JSON.stringify(meta.checkpoints), meta.origin[0], meta.origin[1]],
      );

    const after = (origin: readonly [number, number], last: readonly [number, number]): boolean =>
      origin[0] > last[0] || (origin[0] === last[0] && origin[1] > last[1]);

    // SAFETY: the row's text is decoded by the consumer's schema; the kernel's generics are erased at this store boundary.
    const entries = (key: string, after?: number) =>
      Effect.map(
        sql.query<{ seq: number | string; event: string; envelope: string }>(
          after === undefined
            ? `SELECT seq, event, envelope FROM ${entryTable} WHERE stream = ? AND key = ? ORDER BY seq ASC`
            : `SELECT seq, event, envelope FROM ${entryTable} WHERE stream = ? AND key = ? AND seq > ? ORDER BY seq ASC`,
          after === undefined ? [stream, key] : [stream, key, after],
        ),
        (rows) =>
          rows.map((row): StreamEntry => ({
            seq: Number(row.seq),
            event: parse(row.event) as never,
            envelope: parse(row.envelope) as never,
          })),
      );

    const store: StreamStore = {
      append: (key, write) =>
        sql
          .atomic(
            Effect.gen(function* () {
              const current = yield* read(key);

              if (!after(write.origin, current.origin)) return;
              let seq = current.seq;

              for (const event of write.events) {
                seq += 1;
                yield* sql.write(
                  upsert(
                    executor.dialect,
                    entryTable,
                    ["stream", "key", "seq", "event", "envelope"],
                    ["stream", "key", "seq"],
                  ),
                  [stream, key, seq, JSON.stringify(event), JSON.stringify(envelopeOf(write))],
                );
              }

              yield* writeMeta(key, {
                seq,
                checkpoints: current.checkpoints,
                origin: write.origin,
              });
            }),
          )
          .pipe(Effect.orDie),

      advance: (key, checkpoints) =>
        Effect.gen(function* () {
          const current = yield* read(key);
          const merged = { ...current.checkpoints };

          for (const [source, seq] of Object.entries(checkpoints)) {
            merged[source] = Math.max(merged[source] ?? 0, seq);
          }

          yield* writeMeta(key, { ...current, checkpoints: merged });
        }).pipe(Effect.orDie),

      read: (key) => read(key).pipe(Effect.orDie),

      changes: (key) =>
        poll(pollMillis).pipe(
          Stream.mapEffect(() => read(key)),
          Stream.changesWith((left, right) => left.seq === right.seq),
          Stream.orDie,
        ),

      list: (key) => entries(key).pipe(Effect.orDie),

      tail: (key, after) => {
        let seen = after;

        return poll(pollMillis).pipe(
          Stream.mapEffect(() =>
            Effect.map(entries(key, seen), (rows) => {
              if (rows.length > 0) seen = rows[rows.length - 1]!.seq;

              return rows;
            }),
          ),
          Stream.flatMap((rows) => Stream.fromIterable(rows)),
          Stream.orDie,
        );
      },
    };

    return { store, bind: (_kit: StreamKit) => store };
  });
