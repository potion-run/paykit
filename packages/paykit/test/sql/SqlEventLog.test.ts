import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { migrate } from "../../src/Migrations/index.ts";
import type { SqlExecutor } from "../../src/Store/Sql.ts";
import { SqlEventLog, type AppendInput } from "../../src/Store/SqlEventLog.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const later = DateTime.makeUnsafe("2030-02-01T00:00:00Z");

type Log = ReturnType<typeof SqlEventLog>;

const store = Effect.gen(function* () {
  const sql = sqliteExecutor();
  yield* migrate(sql);
  return { sql, log: SqlEventLog(sql, { now: () => 1_000 }) };
});

const append = (log: Log, overrides: Partial<AppendInput> = {}) =>
  log.append({
    aggregate: "Subscription",
    account: "acct_1",
    commandId: "cmd_1",
    at: 100,
    events: [{ _tag: "Opened", n: 1 }],
    state: { _tag: "Opened", n: 1 },
    receipt: { version: 1 },
    deliveries: [{ target: "Entitlements" }],
    ...overrides,
  });

describe("SqlEventLog", () => {
  it.effect("appends events, state and receipt atomically, then dedupes the command", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* store;
      expect(append(log)).toEqual({ version: 1, duplicate: false });
      expect(append(log)).toEqual({ version: 1, duplicate: true });
      expect(log.events("Subscription", "acct_1").length).toBe(1);
      expect(log.pendingDeliveries().length).toBe(1);

      expect(
        append(log, {
          commandId: "cmd_2",
          at: 200,
          events: [
            { _tag: "Used", n: 2 },
            { _tag: "Used", n: 3 },
          ],
          state: { _tag: "Used", n: 3 },
          receipt: { version: 3 },
        }),
      ).toEqual({ version: 3, duplicate: false });
      expect(log.events("Subscription", "acct_1").map((row) => row.seq)).toEqual([1, 2, 3]);
      expect(JSON.parse(log.state("Subscription", "acct_1")!.state)).toEqual({
        _tag: "Used",
        n: 3,
      });
      expect(
        sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM billing_outbox")?.count,
      ).toBe(3);
    }),
  );

  it.effect("rolls back events, state, receipts and deliveries when a write fails", () =>
    Effect.gen(function* () {
      const base = sqliteExecutor();
      yield* migrate(base);
      const failing: SqlExecutor = {
        ...base,
        run: (statement, params) => {
          if (statement.includes('INSERT INTO "billing_receipt"')) {
            throw new Error("disk full");
          }
          base.run(statement, params);
        },
      };
      const log = SqlEventLog(failing, { now: () => 1_000 });
      expect(() => append(log)).toThrow("disk full");
      expect(
        base.get<{ count: number }>("SELECT COUNT(*) AS count FROM billing_event")?.count,
      ).toBe(0);
      expect(
        base.get<{ count: number }>("SELECT COUNT(*) AS count FROM billing_receipt")?.count,
      ).toBe(0);
      expect(
        base.get<{ count: number }>("SELECT COUNT(*) AS count FROM billing_outbox")?.count,
      ).toBe(0);
      expect(base.get("SELECT * FROM billing_state")).toBeUndefined();
    }),
  );

  it.effect("derives the next version from the event log, not a stale state row", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* store;
      append(log);
      sql.run("DELETE FROM billing_state");
      expect(append(log, { commandId: "cmd_2", events: [{ _tag: "Used" }] })).toEqual({
        version: 2,
        duplicate: false,
      });
      expect(log.events("Subscription", "acct_1").map((row) => row.seq)).toEqual([1, 2]);
    }),
  );

  it.effect("keeps each account's sequence and dedupe scope separate", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      append(log, { account: "acct_a", commandId: "shared" });
      append(log, { account: "acct_b", commandId: "shared" });
      append(log, { account: "acct_b", events: [{ _tag: "Used" }] });
      expect(log.events("Subscription", "acct_a").map((row) => row.seq)).toEqual([1]);
      expect(log.events("Subscription", "acct_b").map((row) => row.seq)).toEqual([1, 2]);
    }),
  );

  it.effect("drains the outbox in order, one delivery per event, bounded by the limit", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      append(log, {
        events: [{ _tag: "Opened" }, { _tag: "Used" }],
        deliveries: [{ target: "Entitlements" }, { target: "BillingRead" }],
      });
      const pending = log.pendingDeliveries();
      expect(pending.map((delivery) => delivery.seq)).toEqual([1, 2, 3, 4]);
      expect(pending.map((delivery) => delivery.eventSeq)).toEqual([1, 1, 2, 2]);
      expect(log.pendingDeliveries(2).map((delivery) => delivery.seq)).toEqual([1, 2]);
      for (const delivery of pending) log.markDelivered(delivery.seq);
      expect(log.pendingDeliveries().length).toBe(0);
    }),
  );

  it.effect("schedules commands durably and reports the ones due", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      log.schedule({
        aggregate: "Subscription",
        account: "acct_1",
        commandId: "period-ended:1",
        dueAt: 10,
        command: "{}",
      });
      log.schedule({
        aggregate: "Subscription",
        account: "acct_2",
        commandId: "period-ended:2",
        dueAt: 20,
        command: "{}",
      });
      expect(log.due(15).map((row) => row.commandId)).toEqual(["period-ended:1"]);
      log.markScheduledDelivered("Subscription", "acct_1", "period-ended:1");
      expect(log.due(15)).toEqual([]);
      expect(log.due(30).map((row) => row.commandId)).toEqual(["period-ended:2"]);
      log.unschedule("Subscription", "acct_2", "period-ended:2");
      expect(log.due(30)).toEqual([]);
    }),
  );

  it.effect("re-scheduling a delivered command makes it due again", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      const command = {
        aggregate: "Subscription",
        account: "acct_1",
        commandId: "period-ended:1",
        dueAt: 10,
        command: "{}",
      };
      log.schedule(command);
      log.markScheduledDelivered(command.aggregate, command.account, command.commandId);
      expect(log.due(30)).toEqual([]);
      log.schedule({ ...command, dueAt: 20 });
      expect(log.due(30).map((row) => row.commandId)).toEqual(["period-ended:1"]);
    }),
  );

  it.effect("upserts one read model row per account and lists it in order", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      const row = {
        account: "acct_1",
        tier: "free",
        status: "active" as const,
        standing: "good" as const,
        periodStart: at,
        periodEnd: later,
        cancelAtPeriodEnd: false,
        credits: 0,
        features: {
          messages: {
            included: 100,
            used: 0,
            reserved: 0,
            allowed: true,
            remaining: 100,
            overage: "block" as const,
            resets: "month" as const,
            resetsAt: later,
          },
          seats: {
            included: 5,
            used: 1,
            reserved: 0,
            allowed: true,
            remaining: 4,
            overage: "allow" as const,
            resets: "never" as const,
            resetsAt: null,
          },
        },
      };
      log.upsertReadModel(row);
      expect(log.readModel("acct_1")).toEqual(row);
      log.upsertReadModel({ ...row, credits: 50 });
      expect(log.readModel("acct_1")?.credits).toBe(50);
      log.upsertReadModel({ ...row, account: "acct_0", currency: "usd" });
      expect(log.readModelList().map((entry) => entry.account)).toEqual(["acct_0", "acct_1"]);
      expect(log.readModel("acct_0")?.currency).toBe("usd");
      expect(log.readModel("acct_1")?.currency).toBeUndefined();
      expect(log.readModel("missing")).toBe(null);
    }),
  );

  it.effect("refuses to read a corrupt read model", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* store;
      sql.run(
        "INSERT INTO billing_rm_billing_read (account, tier, status, standing, period_start, period_end, cancel_at_period_end, credits, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["acct_bad", "free", "active", "good", 0, 1, 0, 0, '{"messages":{"included":"lots"}}'],
      );
      expect(() => log.readModel("acct_bad")).toThrow();
    }),
  );

  it.effect("normalizes numeric columns a driver returns as text", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* store;
      append(log);
      const numeric = new Set([
        "seq",
        "event_seq",
        "version",
        "at",
        "due_at",
        "period_start",
        "period_end",
        "cancel_at_period_end",
        "credits",
      ]);
      const asText = (row: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            numeric.has(key) && typeof value === "number" ? String(value) : value,
          ]),
        );
      // `pg` returns BIGINT columns as strings; the store must not hand those
      // to DateTime or arithmetic.
      const stringy: SqlExecutor = {
        ...sql,
        get: (statement, params) => {
          const row = sql.get<Record<string, unknown>>(statement, params);
          return row === undefined ? undefined : (asText(row) as never);
        },
        all: (statement, params) =>
          sql.all<Record<string, unknown>>(statement, params).map(asText) as never,
      };
      const adapted = SqlEventLog(stringy, { now: () => 1_000 });
      expect(adapted.events("Subscription", "acct_1").map((row) => row.at)).toEqual([100]);
      expect(adapted.pendingDeliveries().map((row) => row.seq)).toEqual([1]);
      expect(append(adapted)).toEqual({ version: 1, duplicate: true });

      log.upsertReadModel({
        account: "acct_1",
        tier: "free",
        status: "active",
        standing: "good",
        periodStart: at,
        periodEnd: later,
        cancelAtPeriodEnd: false,
        credits: 0,
        features: {
          messages: {
            included: 100,
            used: 0,
            reserved: 0,
            allowed: true,
            remaining: 100,
            overage: "block",
            resets: "month",
            resetsAt: later,
          },
        },
      });
      expect(adapted.readModel("acct_1")?.periodEnd).toEqual(later);
    }),
  );

  it.effect("lists every account with events", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      for (const [index, account] of ["acct_b", "acct_a", "acct_a"].entries()) {
        append(log, { account, commandId: `cmd_${account}_${index}` });
      }
      expect(log.accounts("Subscription")).toEqual(["acct_a", "acct_b"]);
    }),
  );
});
