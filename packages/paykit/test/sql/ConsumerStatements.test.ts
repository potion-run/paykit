import { Database } from "bun:sqlite";
import type { Delivery, ViewEntry, ViewSnapshot } from "@alchemy.run/domain/Platform";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { migrate } from "../../src/Migrations/index.ts";
import type { SqlExecutor, SqlValue } from "../../src/Store/Sql.ts";
import { SqlViewStore } from "../../src/Store/SqlConsumers.ts";
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
});
