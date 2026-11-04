import { Database } from "bun:sqlite";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { migrate } from "../../src/Migrations/index.ts";
import { SqlAggregateStore } from "../../src/Store/SqlAggregateStore.ts";
import { SqlEventLog } from "../../src/Store/SqlEventLog.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const account = "acct_sql";

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
});
