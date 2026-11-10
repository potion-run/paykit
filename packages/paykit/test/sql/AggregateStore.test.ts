import { Database } from "bun:sqlite";
import { describe, expect, it } from "@alchemy.run/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { migrate } from "../../src/Migrations/index.ts";
import type { SqlExecutor } from "../../src/Store/Sql.ts";
import { SqlAggregateStore } from "../../src/Store/SqlAggregateStore.ts";
import { SqlEventLog } from "../../src/Store/SqlEventLog.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const account = "acct_sql";

/** The pool a stand-in kernel starts from, so the arithmetic below is obvious. */
const INITIAL_POOL = 100;

/**
 * A stand-in for the kernel with one rule — spend what the snapshot covers —
 * and one deliberate pause: a spend waits at the read until a second spend has
 * read too, so both decisions are taken on the same version. Two processes
 * produce that interleaving for free; a single-process test has to be told to.
 */
const poolKit = (arrivals: Ref.Ref<number>, gate: Deferred.Deferred<void>) => ({
  name: "Pool",
  handle: (input: {
    readonly id: string;
    readonly version: number;
    readonly state: unknown;
    readonly command: unknown;
    readonly commandId: string;
  }) =>
    Effect.gen(function* () {
      const state = (input.state as { readonly pool: number } | null) ?? { pool: INITIAL_POOL };
      const amount = (input.command as { readonly amount: number }).amount;

      if (amount > 0) {
        const arrived = yield* Ref.updateAndGet(arrivals, (seen) => seen + 1);

        if (arrived === 2) yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(gate);
      }

      if (state.pool < amount) {
        return { _tag: "Rejected" as const, rejection: { _tag: "Overdrawn" } };
      }

      const pool = state.pool - amount;

      return {
        _tag: "Accepted" as const,
        state: { pool },
        version: input.version + 1,
        events: [
          {
            event: { _tag: "Spent", amount, poolAfter: pool },
            envelope: {
              id: input.id,
              seq: input.version + 1,
              at: 1,
              commandId: input.commandId,
            },
          },
        ],
        reply: { pool },
        deliveries: [],
      };
    }),
});

/** Bind the stand-in kernel the way a hosted model would. */
const bind = (store: unknown, kit: unknown): void => {
  (store as { bind: (bound: unknown) => void }).bind(kit);
};

/**
 * A kit that records every delivery it is handed and routes one per command,
 * so a test can see the outbox drain reach its target.
 */
const recordingKit = (delivered: Ref.Ref<ReadonlyArray<unknown>>) => ({
  name: "Recording",
  handle: (input: { readonly id: string; readonly version: number; readonly commandId: string }) =>
    Effect.succeed({
      _tag: "Accepted" as const,
      state: { handled: input.commandId },
      version: input.version + 1,
      events: [
        {
          event: { _tag: "Handled", commandId: input.commandId },
          envelope: { id: input.id, seq: input.version + 1, at: 1, commandId: input.commandId },
        },
      ],
      reply: { ok: true },
      deliveries: [{ target: { kind: "view", name: "Entitlements" }, key: input.id }],
    }),
  deliver: (delivery: unknown) => Ref.update(delivered, (seen) => [...seen, delivery]),
});

/**
 * Put `count` undelivered deliveries for another aggregate and account at the
 * front of the outbox. They hold every place in a global page, which is what
 * used to leave an instance's own delivery undrained.
 */
const seedForeignBacklog = (sql: SqlExecutor, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    sql.run(
      "INSERT INTO billing_outbox (aggregate, account, event_seq, delivery) VALUES (?, ?, ?, ?)",
      [
        "Other",
        "acct_backlog",
        index + 1,
        JSON.stringify({ target: { kind: "view", name: "Entitlements" }, key: "acct_backlog" }),
      ],
    );
  }
};

/**
 * A durable log on a real SQLite database. The store is driven directly — the
 * kernel's `kit` is what a hosted model supplies — so these tests assert the
 * guarantees this store owns, not the model's rules.
 */
const world = Effect.gen(function* () {
  const database = new Database(":memory:");
  const clock = { now: 1_700_000_000_000 };
  const sql = sqliteExecutor(database);
  yield* migrate(sql);
  const log = SqlEventLog(sql, { now: () => clock.now });

  return { database, sql, log, clock };
});

const storeOver = (log: ReturnType<typeof SqlEventLog>) =>
  SqlAggregateStore(log, {
    aggregate: "Subscription",
    now: () => 1_700_000_000_000,
    pollMillis: 5,
  });

const appendOnce = (log: ReturnType<typeof SqlEventLog>, commandId: string, amount = 5) =>
  log.append({
    aggregate: "Subscription",
    account,
    commandId,
    at: 1,
    events: [{ _tag: "UsageRecorded", amount }],
    state: { _tag: "Subscribed" },
    receipt: { stream: `Subscription/${account}`, version: 1, events: [], reply: {} },
    deliveries: [],
  });

describe("the SQL aggregate store", () => {
  it.effect("refuses to run before the kernel bound it, rather than inventing an outcome", () =>
    Effect.gen(function* () {
      const { log } = yield* world;
      const store = yield* storeOver(log);

      const exit = yield* Effect.exit(
        store.send(
          account,
          { _tag: "Subscribe" } as never,
          {
            commandId: "cmd-1",
            context: {},
          } as never,
        ),
      );

      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("dedupes by command id without deciding again", () =>
    Effect.gen(function* () {
      const { log } = yield* world;
      yield* appendOnce(log, "cmd-1");
      // A second write of the same id is a duplicate: the log keeps the first
      // events, state and receipt, so a retried webhook is not a second charge.
      const again = yield* appendOnce(log, "cmd-1", 99);
      expect(again.duplicate).toBe(true);
      expect(again.version).toBe(1);
      expect((yield* log.events("Subscription", account)).length).toBe(1);
      expect(JSON.parse((yield* log.receipt("Subscription", account, "cmd-1"))!).version).toBe(1);
    }),
  );

  it.effect("keeps the event log as the truth after a restart", () =>
    Effect.gen(function* () {
      const { database, log } = yield* world;
      yield* appendOnce(log, "cmd-1", 7);
      // A second connection to the same database sees the commit — which is
      // what a redeploy, a second isolate, or a kill -9 mid-command must see.
      const reopened = SqlEventLog(sqliteExecutor(database), { now: () => 2 });
      expect((yield* reopened.events("Subscription", account)).length).toBe(1);
      expect((yield* reopened.state("Subscription", account))?.version).toBe(1);
      expect(JSON.parse((yield* reopened.receipt("Subscription", account, "cmd-1"))!)).toEqual({
        stream: `Subscription/${account}`,
        version: 1,
        events: [],
        reply: {},
      });
    }),
  );

  it.effect("gives one writer per account, so a second commit takes the next sequence", () =>
    Effect.gen(function* () {
      const { log } = yield* world;
      yield* appendOnce(log, "a");
      yield* appendOnce(log, "b");
      expect((yield* log.events("Subscription", account)).map((row) => row.seq)).toEqual([1, 2]);
      expect((yield* log.state("Subscription", account))?.version).toBe(2);
    }),
  );

  it.effect("holds a delivery in the outbox until its target accepted it", () =>
    Effect.gen(function* () {
      const { log } = yield* world;
      yield* log.append({
        aggregate: "Subscription",
        account,
        commandId: "cmd-1",
        at: 1,
        events: [{ _tag: "UsageRecorded", amount: 1 }],
        state: {},
        receipt: {},
        deliveries: [
          { target: { kind: "view", name: "Entitlements" }, key: account, seq: 1 },
          { target: { kind: "view", name: "BillingState" }, key: account, seq: 1 },
        ],
      });
      expect((yield* log.pendingDeliveries()).length).toBe(2);
      // Marked only after the target accepted it: a crash before that replays
      // rather than dropping, which is what at-least-once means.
      const pending = yield* log.pendingDeliveries();
      yield* log.markDelivered(pending[0]!.seq);
      expect((yield* log.pendingDeliveries()).length).toBe(1);
      expect((yield* log.pendingDeliveries())[0]!.eventSeq).toBe(1);
    }),
  );

  it.effect("keeps a scheduled command across a restart, and unschedules it by id", () =>
    Effect.gen(function* () {
      const { database, log, clock } = yield* world;
      const store = yield* storeOver(log);
      yield* log.schedule({
        aggregate: "Subscription",
        account,
        commandId: "close-period",
        dueAt: clock.now + 500,
        command: JSON.stringify({ command: { _tag: "PeriodEnded" }, meta: {} }),
      });
      const reopened = SqlEventLog(sqliteExecutor(database), { now: () => clock.now + 600 });
      expect((yield* reopened.due(clock.now + 600)).map((row) => row.commandId)).toEqual([
        "close-period",
      ]);
      expect(yield* log.pendingFor("Subscription", account, "close-period")).toBeDefined();
      yield* store.unschedule(account, "close-period");
      expect(yield* reopened.due(clock.now + 600)).toEqual([]);
    }),
  );

  it.effect("refuses to schedule a command id that already ran", () =>
    Effect.gen(function* () {
      const { log } = yield* world;
      const store = yield* storeOver(log);
      yield* appendOnce(log, "cmd-1");

      const exit = yield* Effect.exit(
        store.schedule(
          account,
          { _tag: "PeriodEnded" } as never,
          { commandId: "cmd-1", context: {} } as never,
          { at: 1 } as never,
        ),
      );

      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("AlreadyExecuted");
    }),
  );

  it.effect("refuses to unschedule something that was never scheduled", () =>
    Effect.gen(function* () {
      const { log } = yield* world;
      const store = yield* storeOver(log);
      const exit = yield* Effect.exit(store.unschedule(account, "never-scheduled"));
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("NotScheduled");
    }),
  );

  it.effect("reads an empty state for an instance that never committed", () =>
    Effect.gen(function* () {
      const { log } = yield* world;
      const store = yield* storeOver(log);
      const state = yield* store.state(account);
      expect(state.version).toBe(0);
      expect(state.state).toBeNull();
      expect(yield* store.events!(account)).toEqual([]);
    }),
  );

  it.effect("drains its own instance past a full page of another account's backlog", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* world;

      // 150 deliveries another aggregate committed first: every place in an
      // unfiltered page belongs to it, so a drain that reads one never reaches
      // this instance's row.
      seedForeignBacklog(sql, 150);

      const delivered = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const store = yield* storeOver(log);
      bind(store, recordingKit(delivered));

      const result = yield* store.send(
        account,
        { amount: 1 } as never,
        { commandId: "spend-after-backlog", context: {} } as never,
      );

      expect(result._tag).toBe("Accepted");
      // The delivery this commit staged reached the kit …
      expect(yield* Ref.get(delivered)).toEqual([
        { target: { kind: "view", name: "Entitlements" }, key: account },
      ]);
      // … its own outbox is empty …
      expect(yield* log.pendingDeliveries(500, { aggregate: "Subscription", account })).toEqual([]);
      // … and the other account's backlog is untouched.
      expect((yield* log.pendingDeliveries(500)).length).toBe(150);
      expect((yield* log.pendingDeliveries(500, { aggregate: "Other" })).length).toBe(150);
    }),
  );

  it.effect("re-decides a command instead of publishing a state its log cannot explain", () =>
    Effect.gen(function* () {
      const { log } = yield* world;
      const store = yield* storeOver(log);
      const arrivals = yield* Ref.make(0);
      const gate = yield* Deferred.make<void>();
      bind(store, poolKit(arrivals, gate));

      yield* store.send(
        account,
        { amount: 0 } as never,
        {
          commandId: "open",
          context: {},
        } as never,
      );

      // Two spends of 60 against a pool of 100, decided on the same version.
      // Only one may land: the second is made on a pool the first already
      // spent, so writing it would leave a state the log does not add up to.
      const outcomes = yield* Effect.forEach(
        ["spend-a", "spend-b"],
        (commandId) =>
          store.send(account, { amount: 60 } as never, { commandId, context: {} } as never),
        { concurrency: "unbounded" },
      );

      const grown = yield* store.state(account);
      const events = yield* store.events!(account);

      const fold = events.reduce(
        (pool, row) => pool - (row.event as { readonly amount: number }).amount,
        INITIAL_POOL,
      );

      expect(outcomes.filter((outcome) => outcome._tag === "Rejected").length).toBe(1);
      expect(fold).toBe(40);
      expect((grown.state as { readonly pool: number }).pool).toBe(fold);
    }),
  );
});
