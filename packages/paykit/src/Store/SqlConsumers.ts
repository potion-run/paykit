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
import * as Stream from "effect/Stream";
import { asyncOf, type SqlAsync, type SqlDialect, type SqlExecutor, type SqlValue } from "./Sql.ts";
import { BILLING_TABLES, tableName, type TableScope } from "./Tables.ts";

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
}

const DEFAULT_POLL = 250;

const parse = (json: string | null): unknown => (json === null ? null : JSON.parse(json));

const poll = (interval: number) => Stream.tick(Duration.millis(interval));

const columns = (names: ReadonlyArray<string>): string => names.join(", ");
const placeholders = (names: ReadonlyArray<string>): string => names.map(() => "?").join(", ");

/** `INSERT OR IGNORE` on SQLite, `ON CONFLICT DO NOTHING` on Postgres. */
const insertIgnore = (dialect: SqlDialect, table: string, names: ReadonlyArray<string>): string =>
  dialect === "postgres"
    ? `INSERT INTO ${table} (${columns(names)}) VALUES (${placeholders(names)}) ON CONFLICT DO NOTHING`
    : `INSERT OR IGNORE INTO ${table} (${columns(names)}) VALUES (${placeholders(names)})`;

/** Upsert one row by its primary key. */
const upsert = (table: string, names: ReadonlyArray<string>, key: ReadonlyArray<string>): string =>
  `INSERT INTO ${table} (${columns(names)}) VALUES (${placeholders(names)})
   ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${names
     .filter((name) => !key.includes(name))
     .map((name) => `${name} = excluded.${name}`)
     .join(", ")}`;

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
    const pollMillis = options.pollMillis ?? DEFAULT_POLL;
    const view = options.name;

    const read = (key: string, generation: number) =>
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
      generation: number,
    ) =>
      sql.atomic(
        Effect.gen(function* () {
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
                entry,
                ["view", "key", "seq", "event", "envelope", "state"],
                ["view", "key", "seq"],
              ),
              [
                view,
                key,
                emitted.seq,
                JSON.stringify(emitted.event),
                JSON.stringify(emitted.envelope),
                JSON.stringify(emitted.state),
              ],
            );
          }
        }),
      );

    let kit: ViewKit | undefined;

    const entries = (key: string, after?: number) =>
      Effect.map(
        sql.query<{
          seq: number | string;
          event: string;
          envelope: string;
          state: string;
        }>(
          after === undefined
            ? `SELECT seq, event, envelope, state FROM ${entry} WHERE view = ? AND key = ? ORDER BY seq ASC`
            : `SELECT seq, event, envelope, state FROM ${entry} WHERE view = ? AND key = ? AND seq > ? ORDER BY seq ASC`,
          after === undefined ? [view, key] : [view, key, after],
        ),
        (rows) =>
          rows.map((row): ViewEntry => ({
            seq: Number(row.seq),
            event: parse(row.event) as never,
            envelope: parse(row.envelope) as never,
            state: parse(row.state) as never,
          })),
      );

    const store: ViewStore = {
      receive: (key, deliveries) =>
        Effect.gen(function* () {
          const bound = kit;
          if (bound === undefined) return yield* Effect.die("view store used before it was built");
          if (deliveries.length === 0) return;
          const generation = bound.generation;
          const snapshot = yield* read(key, generation);
          // Dedupe before applying: at-least-once delivery means the same event
          // can arrive twice, and a view that applied both would double it.
          const fresh: Array<Delivery> = [];
          for (const delivery of deliveries) {
            if (!(yield* alreadyApplied(key, delivery, generation))) fresh.push(delivery);
          }
          if (fresh.length === 0) return;
          const applied = yield* bound.apply(key, snapshot, fresh);
          if (applied.changed) {
            yield* write(key, snapshot, applied.snapshot, applied.entries, fresh, generation);
          }
          yield* Effect.forEach(applied.downstream, (delivery) => bound.deliver(delivery), {
            discard: true,
          });
        }).pipe(Effect.orDie),

      read: (key) =>
        Effect.gen(function* () {
          const bound = kit;
          if (bound === undefined) return yield* Effect.die("view store used before it was built");
          return yield* read(key, bound.generation);
        }).pipe(Effect.orDie),

      changes: (key) =>
        poll(pollMillis).pipe(
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              const bound = kit;
              if (bound === undefined)
                return yield* Effect.die("view store used before it was built");
              return yield* read(key, bound.generation);
            }),
          ),
          Stream.changesWith((left, right) => left.version === right.version),
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

    return {
      store,
      bind: (built: ViewKit) => {
        kit = built;
        return store;
      },
    };
  });

/**
 * A projection's durable input log and cursor. `receive` accepts a delivery
 * once (by `source` and `seq`), appends it to the key's log, then runs what
 * the cursor has not marked done — so a crash mid-batch replays the batch
 * rather than skipping it.
 *
 * @primitive
 */
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
        const pending = yield* Effect.map(
          sql.query<{
            position: number | string;
            delivery: string;
            accepted_at: number | string;
          }>(
            `SELECT position, delivery, accepted_at FROM ${input}
             WHERE projection = ? AND key = ? AND processed_at IS NULL ORDER BY position ASC`,
            [projection, key],
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
              upsert(cursors, ["projection", "key", "position"], ["projection", "key"]),
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
          if (
            delivery.target.generation !== undefined &&
            delivery.target.generation !== bound.generation
          ) {
            return;
          }
          yield* sql.atomic(
            Effect.gen(function* () {
              const last = yield* sql.get<{ position: number | string }>(
                `SELECT COALESCE(MAX(position), 0) AS position FROM ${input} WHERE projection = ? AND key = ?`,
                [projection, delivery.key],
              );
              const next = Number(last?.position ?? 0) + 1;
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
      // whose row is marked processed.
      checkpoints: (key) =>
        Effect.map(
          sql.query<{ source: string; seq: number | string }>(
            `SELECT source, MAX(source_seq) AS seq FROM ${input}
             WHERE projection = ? AND key = ? AND processed_at IS NOT NULL GROUP BY source`,
            [projection, key],
          ),
          (rows) => Object.fromEntries(rows.map((row) => [row.source, Number(row.seq)])) as never,
        ).pipe(Effect.orDie),
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

const envelopeOf = (write: StreamWrite): EnvelopeJson =>
  ({
    id: write.commandId,
    stream: write.source,
    seq: write.sourceSeq,
    at: new Date(write.at),
    commandId: write.commandId,
    correlationId: write.commandId,
  }) as unknown as EnvelopeJson;

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
          metaTable,
          ["stream", "key", "seq", "checkpoints", "origin_a", "origin_b"],
          ["stream", "key"],
        ),
        [stream, key, meta.seq, JSON.stringify(meta.checkpoints), meta.origin[0], meta.origin[1]],
      );

    const after = (origin: readonly [number, number], last: readonly [number, number]): boolean =>
      origin[0] > last[0] || (origin[0] === last[0] && origin[1] > last[1]);

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
