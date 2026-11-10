import { Database } from "bun:sqlite";
import type { Delivery, ViewEntry, ViewSnapshot } from "@alchemy.run/domain/Platform";
import { describe, expect, it } from "@alchemy.run/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { migrate } from "../../src/Migrations/index.ts";
import type { SqlExecutor, SqlValue } from "../../src/Store/Sql.ts";
import { CAUGHT_UP_CAP, SqlViewStore } from "../../src/Store/SqlConsumers.ts";
import { BILLING_TABLES } from "../../src/Store/Tables.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const VIEW = "Counter";
const KEY = "acct_counter";
const AT = 1_700_000_000_000;

const delivery = (seq: number, source = `Account/${KEY}`, generation = 1): Delivery => ({
  target: { kind: "view", name: VIEW, generation },
  key: KEY,
  source,
  seq,
  origin: "Account",
  tag: "Ticked",
  event: { _tag: "Ticked", seq },
  envelope: {
    id: KEY,
    stream: source,
    seq,
    at: AT,
    commandId: `command-${seq}`,
    correlationId: `command-${seq}`,
  },
});

const countOf = (snapshot: ViewSnapshot): number =>
  snapshot.state === null ? 0 : (snapshot.state as { readonly count: number }).count;

/** The same delivery, for a key other than the shared fixture's. */
const keyedDelivery = (key: string, seq: number, generation = 1): Delivery => ({
  ...delivery(seq, `Account/${key}`, generation),
  key,
});

/** A kit that folds each delivery into a count and emits one entry for it. */
const foldKit = (
  generation: number,
  options: {
    readonly downstream?: (delivery: Delivery, entry: ViewEntry) => ReadonlyArray<Delivery>;
    readonly deliver?: (delivery: Delivery) => Effect.Effect<void>;
  } = {},
) => ({
  generation,
  apply: (_key: string, snapshot: ViewSnapshot, deliveries: ReadonlyArray<Delivery>) => {
    let count = countOf(snapshot);
    let seq = snapshot.seq;
    const entries: Array<ViewEntry> = [];
    const downstream: Array<Delivery> = [];

    for (const item of deliveries) {
      count += 1;
      seq += 1;

      const entry: ViewEntry = {
        seq,
        event: item.event,
        envelope: item.envelope,
        state: { count },
      };

      entries.push(entry);
      downstream.push(...(options.downstream?.(item, entry) ?? []));
    }

    return Effect.succeed({
      snapshot: {
        state: { count },
        version: snapshot.version + deliveries.length,
        checkpoints: { ...snapshot.checkpoints },
        seq,
        generation,
      },
      changed: deliveries.length > 0,
      entries,
      downstream,
    });
  },
  deliver: options.deliver ?? (() => Effect.void),
});

/** Record every read and write the store sends through the executor. */
const counting = (inner: SqlExecutor) => {
  const reads: Array<string> = [];
  const writes: Array<string> = [];
  const query = inner.query!;
  const get = inner.get;
  const write = inner.write!;

  const sql: SqlExecutor = {
    ...inner,
    query: <A>(statement: string, params?: ReadonlyArray<SqlValue>) => {
      reads.push(statement);

      return query<A>(statement, params);
    },
    get: <A>(statement: string, params?: ReadonlyArray<SqlValue>) => {
      reads.push(statement);

      return get<A>(statement, params);
    },
    write: (statement: string, params?: ReadonlyArray<SqlValue>) => {
      writes.push(statement);

      return write(statement, params);
    },
  };

  return { sql, reads, writes };
};

interface CountedWorld {
  readonly database: Database;
  readonly sql: SqlExecutor;
  readonly reads: Array<string>;
  readonly writes: Array<string>;
}

const withWorld = <A, E, R>(run: (world: CountedWorld) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = new Database(":memory:");
    const executor = sqliteExecutor(database);
    yield* migrate(executor);
    const counted = counting(executor);

    return yield* Effect.ensuring(
      run({ database, ...counted }),
      Effect.sync(() => database.close()),
    );
  });

describe("the statements a view store sends", () => {
  it.effect("reads the input log once per source for a batch, not once per delivery", () =>
    withWorld(({ sql, reads }) =>
      Effect.gen(function* () {
        const view = yield* SqlViewStore(sql, { name: VIEW, now: () => AT });
        const store = view.bind(foldKit(1) as never);
        const batch = Array.from({ length: 50 }, (_, index) => delivery(index + 1));

        // Before this change every delivery ran its own `alreadyApplied`
        // SELECT: 50 reads plus the snapshot, the stored generation and the
        // outbox drain, 53 reads and 103 writes in all. The batch now costs 4
        // reads and 101 writes, and the fold still sees all 50 deliveries.
        // A warm `trackUsage` on the real model went from 27 reads / 37 writes
        // to 27 reads / 33 writes.
        yield* store.receive(KEY, batch);

        expect(reads.length).toBeLessThan(12);

        const snapshot = yield* store.read(KEY);

        expect(snapshot.version).toBe(50);
        expect(countOf(snapshot)).toBe(50);
      }),
    ),
  );

  it.effect("is a no-op when the same batch is delivered again", () =>
    withWorld(({ sql, writes }) =>
      Effect.gen(function* () {
        const view = yield* SqlViewStore(sql, { name: VIEW, now: () => AT });
        const store = view.bind(foldKit(1) as never);
        const batch = Array.from({ length: 50 }, (_, index) => delivery(index + 1));

        yield* store.receive(KEY, batch);
        const before = yield* store.read(KEY);

        const entryWrites = writes.filter((statement) =>
          statement.includes(BILLING_TABLES.viewEntry),
        ).length;

        const writesBefore = writes.length;

        yield* store.receive(KEY, batch);

        const after = yield* store.read(KEY);

        expect(after.version).toBe(before.version);
        expect(countOf(after)).toBe(countOf(before));
        expect((yield* store.list(KEY)).length).toBe(50);
        expect(writes.length).toBe(writesBefore);
        expect(
          writes.filter((statement) => statement.includes(BILLING_TABLES.viewEntry)).length,
        ).toBe(entryWrites);
      }),
    ),
  );

  it.effect("still clears a key built by an earlier generation and rebuilds it", () =>
    withWorld(({ sql }) =>
      Effect.gen(function* () {
        const view = yield* SqlViewStore(sql, { name: VIEW, now: () => AT });
        const first = view.bind(foldKit(1) as never);

        yield* first.receive(KEY, [delivery(1), delivery(2)]);
        expect(countOf(yield* first.read(KEY))).toBe(2);

        const rebuilt = view.bind(foldKit(2) as never);

        yield* rebuilt.receive(KEY, [delivery(3, `Account/${KEY}`, 2)]);

        const snapshot = yield* rebuilt.read(KEY);

        expect(snapshot.generation).toBe(2);
        expect(snapshot.version).toBe(1);
        expect(countOf(snapshot)).toBe(1);
        expect(
          sql.all(
            `SELECT seq FROM ${BILLING_TABLES.viewEntry} WHERE view = ? AND key = ? AND generation = ?`,
            [VIEW, KEY, 1],
          ).length,
        ).toBe(0);
        expect(
          sql.all(
            `SELECT source_seq FROM ${BILLING_TABLES.viewInput} WHERE view = ? AND key = ? AND generation = ?`,
            [VIEW, KEY, 1],
          ).length,
        ).toBe(0);
        expect(
          sql.all(
            `SELECT seq FROM ${BILLING_TABLES.viewEntry} WHERE view = ? AND key = ? AND generation = ?`,
            [VIEW, KEY, 2],
          ).length,
        ).toBe(1);
        expect(
          sql.all(
            `SELECT source_seq FROM ${BILLING_TABLES.viewInput} WHERE view = ? AND key = ? AND generation = ?`,
            [VIEW, KEY, 2],
          ).length,
        ).toBe(1);
      }),
    ),
  );

  it.effect("lands a downstream delivery exactly once", () =>
    withWorld(({ sql, writes }) =>
      Effect.gen(function* () {
        const downstream: Delivery = {
          target: { kind: "projection", name: "BillingRead" },
          key: KEY,
          source: `Counter/${KEY}`,
          seq: 1,
          origin: "Counter",
          tag: "CounterEmitted",
          event: { _tag: "CounterEmitted" },
          envelope: {
            id: KEY,
            stream: `Counter/${KEY}`,
            seq: 1,
            at: AT,
            commandId: "counter-1",
            correlationId: "counter-1",
          },
        };

        const delivered: Array<Delivery> = [];
        let pendingAtDeliver = 0;
        const view = yield* SqlViewStore(sql, { name: VIEW, now: () => AT });

        const store = view.bind(
          foldKit(1, {
            downstream: (_item, entry) => [{ ...downstream, seq: entry.seq }],
            deliver: (item) =>
              Effect.sync(() => {
                delivered.push(item);
                pendingAtDeliver = Number(
                  sql.get<{ count: number | string }>(
                    `SELECT COUNT(*) AS count FROM ${BILLING_TABLES.viewOutbox} WHERE view = ? AND key = ?`,
                    [VIEW, KEY],
                  )?.count ?? 0,
                );
              }),
          }) as never,
        );

        yield* store.receive(KEY, [delivery(1)]);

        expect(delivered.length).toBe(1);
        expect(pendingAtDeliver).toBe(1);
        expect(
          writes.filter(
            (statement) =>
              statement.includes("INSERT INTO") && statement.includes(BILLING_TABLES.viewOutbox),
          ).length,
        ).toBe(1);
        expect(
          sql.get(`SELECT 1 AS one FROM ${BILLING_TABLES.viewOutbox} WHERE view = ? AND key = ?`, [
            VIEW,
            KEY,
          ]),
        ).toBeUndefined();
      }),
    ),
  );

  it.effect("drops every lock entry once 300 distinct keys are written", () =>
    withWorld(({ sql }) =>
      Effect.gen(function* () {
        const view = yield* SqlViewStore(sql, { name: VIEW, now: () => AT });
        const store = view.bind(foldKit(1) as never);
        const keys = Array.from({ length: 300 }, (_, index) => `${KEY}_${index}`);

        for (const [index, key] of keys.entries()) {
          yield* store.receive(key, [keyedDelivery(key, index + 1)]);
        }

        // Each receive took a reference to its key and released it; nothing
        // here should still hold a semaphore for an account it has finished.
        expect(view.diagnostics.lockSize()).toBe(0);

        const snapshot = yield* store.read(keys[42]!);

        expect(snapshot.version).toBe(1);
        expect(countOf(snapshot)).toBe(1);
      }),
    ),
  );

  it.effect("bounds the caught-up markers and re-reads a key it forgot", () =>
    withWorld(({ sql, reads }) =>
      Effect.gen(function* () {
        const view = yield* SqlViewStore(sql, { name: VIEW, now: () => AT });

        const store = view.bind({
          ...foldKit(1),
          catchUp: { source: "Account" },
        } as never);

        // The first key touched is the oldest marker, so a sweep past the cap
        // is what forgets it.
        yield* store.receive(KEY, [delivery(1)]);

        const keys = Array.from(
          { length: CAUGHT_UP_CAP + 50 },
          (_, index) => `${KEY}_touched_${index}`,
        );

        for (const key of keys) yield* store.read(key);

        expect(view.diagnostics.caughtUpSize()).toBe(CAUGHT_UP_CAP);

        const stateReads = () =>
          reads.filter((statement) => statement.includes(BILLING_TABLES.viewState)).length;

        // A key still in the fast path answers from the snapshot it reads once.
        const warmBefore = stateReads();

        yield* store.read(keys[keys.length - 1]!);
        expect(stateReads() - warmBefore).toBe(1);

        // A forgotten key re-reads the snapshot in `ensureCaughtUp` and marks
        // itself again; a miss costs a read, never a wrong answer.
        const forgottenBefore = stateReads();
        const snapshot = yield* store.read(KEY);

        expect(stateReads() - forgottenBefore).toBe(2);
        expect(snapshot.version).toBe(1);
        expect(countOf(snapshot)).toBe(1);
        expect(view.diagnostics.caughtUpSize()).toBe(CAUGHT_UP_CAP);
      }),
    ),
  );

  it.live("changes emits the current value, then one value per another writer's commit", () =>
    withWorld(({ sql }) =>
      Effect.gen(function* () {
        const reader = yield* SqlViewStore(sql, { name: VIEW, now: () => AT, pollMillis: 5 });
        const writer = yield* SqlViewStore(sql, { name: VIEW, now: () => AT, pollMillis: 5 });
        const subscriber = reader.bind(foldKit(1) as never);
        const publisher = writer.bind(foldKit(1) as never);
        const first = yield* Deferred.make<void>();

        const watched = subscriber.changes(KEY).pipe(
          Stream.tap((snapshot) =>
            snapshot.version === 0 ? Deferred.succeed(first, undefined) : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
        );

        const fiber = yield* Effect.forkChild(watched);

        // The first value is the snapshot as it stands, before any write.
        yield* Deferred.await(first);
        // A second store over the same database: a cheap version read that
        // only looked in this instance's memory would never see this commit.
        yield* publisher.receive(KEY, [delivery(1)]);

        const emitted = Array.from(yield* Fiber.join(fiber));

        expect(emitted.map((snapshot) => snapshot.version)).toEqual([0, 1]);
        expect(emitted.map(countOf)).toEqual([0, 1]);
      }),
    ),
  );
});
