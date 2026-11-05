import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { migrate } from "../../src/Migrations/index.ts";
import { SqlError, type SqlExecutor } from "../../src/Store/Sql.ts";
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

const count = (sql: SqlExecutor, table: string) =>
  Effect.map(
    sql.query!<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`),
    (rows) => rows[0]?.count,
  );

const readModelRow = {
  account: "acct_1",
  tier: "free",
  status: "active" as const,
  standing: "good" as const,
  periodStart: at,
  periodEnd: later,
  cancelAtPeriodEnd: false,
  credits: 0,
  dunningAttempts: 0,
  features: {
    messages: {
      included: 100,
      used: 0,
      reserved: 0,
      carried: 0,
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
      carried: 0,
      allowed: true,
      remaining: 4,
      overage: "allow" as const,
      resets: "never" as const,
      resetsAt: null,
    },
  },
};

describe("SqlEventLog", () => {
  it.effect("appends events, state and receipt atomically, then dedupes the command", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* store;
      expect(yield* append(log)).toEqual({ version: 1, duplicate: false, conflict: false });
      expect(yield* append(log)).toEqual({ version: 1, duplicate: true, conflict: false });
      expect((yield* log.events("Subscription", "acct_1")).length).toBe(1);
      expect((yield* log.pendingDeliveries()).length).toBe(1);

      expect(
        yield* append(log, {
          commandId: "cmd_2",
          at: 200,
          events: [
            { _tag: "Used", n: 2 },
            { _tag: "Used", n: 3 },
          ],
          state: { _tag: "Used", n: 3 },
          receipt: { version: 3 },
        }),
      ).toEqual({ version: 3, duplicate: false, conflict: false });
      expect((yield* log.events("Subscription", "acct_1")).map((row) => row.seq)).toEqual([
        1, 2, 3,
      ]);
      expect(JSON.parse((yield* log.state("Subscription", "acct_1"))!.state)).toEqual({
        _tag: "Used",
        n: 3,
      });
      expect(yield* count(sql, "billing_outbox")).toBe(3);
    }),
  );

  it.effect("rolls back events, state, receipts and deliveries when a write fails", () =>
    Effect.gen(function* () {
      const base = sqliteExecutor();
      yield* migrate(base);
      const failing: SqlExecutor = {
        ...base,
        write: (statement, params) =>
          statement.includes("billing_receipt")
            ? Effect.fail(new SqlError({ message: "disk full", statement }))
            : base.write!(statement, params),
      };
      const log = SqlEventLog(failing, { now: () => 1_000 });
      const exit = yield* Effect.exit(append(log));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* count(base, "billing_event")).toBe(0);
      expect(yield* count(base, "billing_receipt")).toBe(0);
      expect(yield* count(base, "billing_outbox")).toBe(0);
      expect((yield* base.query!("SELECT * FROM billing_state")).length).toBe(0);
    }),
  );

  it.effect("derives the next version from the event log, not a stale state row", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* store;
      yield* append(log);
      sql.run("DELETE FROM billing_state");
      expect(yield* append(log, { commandId: "cmd_2", events: [{ _tag: "Used" }] })).toEqual({
        version: 2,
        duplicate: false,
        conflict: false,
      });
      expect((yield* log.events("Subscription", "acct_1")).map((row) => row.seq)).toEqual([1, 2]);
    }),
  );

  it.effect("keeps each account's sequence and dedupe scope separate", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      yield* append(log, { account: "acct_a", commandId: "shared" });
      yield* append(log, { account: "acct_b", commandId: "shared" });
      yield* append(log, { account: "acct_b", events: [{ _tag: "Used" }] });
      expect((yield* log.events("Subscription", "acct_a")).map((row) => row.seq)).toEqual([1]);
      expect((yield* log.events("Subscription", "acct_b")).map((row) => row.seq)).toEqual([1, 2]);
    }),
  );

  it.effect("drains the outbox in order, one delivery per event, bounded by the limit", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      yield* append(log, {
        events: [{ _tag: "Opened" }, { _tag: "Used" }],
        deliveries: [{ target: "Entitlements" }, { target: "BillingRead" }],
      });
      const pending = yield* log.pendingDeliveries();
      expect(pending.map((delivery) => delivery.seq)).toEqual([1, 2, 3, 4]);
      expect(pending.map((delivery) => delivery.eventSeq)).toEqual([1, 1, 2, 2]);
      expect((yield* log.pendingDeliveries(2)).map((delivery) => delivery.seq)).toEqual([1, 2]);
      for (const delivery of pending) yield* log.markDelivered(delivery.seq);
      expect((yield* log.pendingDeliveries()).length).toBe(0);
    }),
  );

  it.effect("schedules commands durably and reports the ones due", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      yield* log.schedule({
        aggregate: "Subscription",
        account: "acct_1",
        commandId: "period-ended:1",
        dueAt: 10,
        command: "{}",
      });
      yield* log.schedule({
        aggregate: "Subscription",
        account: "acct_2",
        commandId: "period-ended:2",
        dueAt: 20,
        command: "{}",
      });
      expect((yield* log.due(15)).map((row) => row.commandId)).toEqual(["period-ended:1"]);
      yield* log.markScheduledDelivered("Subscription", "acct_1", "period-ended:1");
      expect(yield* log.due(15)).toEqual([]);
      expect((yield* log.due(30)).map((row) => row.commandId)).toEqual(["period-ended:2"]);
      yield* log.unschedule("Subscription", "acct_2", "period-ended:2");
      expect(yield* log.due(30)).toEqual([]);
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
      yield* log.schedule(command);
      yield* log.markScheduledDelivered(command.aggregate, command.account, command.commandId);
      expect(yield* log.due(30)).toEqual([]);
      yield* log.schedule({ ...command, dueAt: 20 });
      expect((yield* log.due(30)).map((row) => row.commandId)).toEqual(["period-ended:1"]);
    }),
  );

  it.effect("upserts one read model row per account and lists it in order", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      yield* log.upsertReadModel(readModelRow);
      expect(yield* log.readModel("acct_1")).toEqual(readModelRow);
      yield* log.upsertReadModel({ ...readModelRow, credits: 50 });
      expect((yield* log.readModel("acct_1"))?.credits).toBe(50);
      yield* log.upsertReadModel({ ...readModelRow, account: "acct_0", currency: "usd" });
      expect((yield* log.readModelList()).map((entry) => entry.account)).toEqual([
        "acct_0",
        "acct_1",
      ]);
      expect((yield* log.readModel("acct_0"))?.currency).toBe("usd");
      expect((yield* log.readModel("acct_1"))?.currency).toBeUndefined();
      expect(yield* log.readModel("missing")).toBe(null);
    }),
  );

  it.effect("round-trips an unlimited feature's absent count through the JSON column", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      const unlimited = {
        ...readModelRow,
        features: {
          reports: {
            included: "unlimited" as const,
            used: 2_000_000,
            reserved: 0,
            carried: 0,
            allowed: true,
            remaining: null,
            overage: "allow" as const,
            resets: "month" as const,
            resetsAt: later,
          },
        },
      };
      yield* log.upsertReadModel(unlimited);
      const read = yield* log.readModel("acct_1");
      // `null` is the absence of a count; a store that turned it into 0 would
      // report a spent-out allowance that never runs out.
      expect(read?.features.reports?.included).toBe("unlimited");
      expect(read?.features.reports?.remaining).toBeNull();
      expect(read?.features.reports?.used).toBe(2_000_000);
      expect(read).toEqual(unlimited);
    }),
  );

  it.effect("round-trips a flag's judgement, and no counter, through the JSON column", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      const flagged = {
        ...readModelRow,
        features: {
          sso: {
            included: 1,
            used: 0,
            reserved: 0,
            carried: 0,
            allowed: true,
            remaining: null,
            overage: "allow" as const,
            resets: "never" as const,
            resetsAt: null,
          },
        },
      };
      yield* log.upsertReadModel(flagged);
      const read = yield* log.readModel("acct_1");
      // The read model carries the judgement (`allowed`), not a counter it
      // invented: an on/off capability has nothing to spend down.
      expect(read?.features.sso?.allowed).toBe(true);
      expect(read?.features.sso?.remaining).toBeNull();
      expect(read?.features.sso?.included).toBe(1);
      expect(read).toEqual(flagged);
    }),
  );

  it.effect("round-trips a carried amount through the JSON column", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      const rolled = {
        ...readModelRow,
        features: {
          messages: {
            included: 2_000,
            used: 0,
            reserved: 0,
            carried: 1_480,
            allowed: true,
            remaining: 3_480,
            overage: "block" as const,
            resets: "month" as const,
            resetsAt: later,
          },
        },
      };
      yield* log.upsertReadModel(rolled);
      const read = yield* log.readModel("acct_1");
      // The carry is visible on the row, not folded into `remaining` alone.
      expect(read?.features.messages?.carried).toBe(1_480);
      expect(read?.features.messages?.remaining).toBe(3_480);
      expect(read).toEqual(rolled);
    }),
  );

  it.effect("round-trips a credit-priced feature's pool through the JSON column", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      const metered = {
        ...readModelRow,
        credits: 49_000,
        features: {
          ai: {
            creditRates: { default: 1, "gpt-large": 10 },
            included: null,
            used: 1_000,
            reserved: 0,
            remaining: 49_000,
            carried: 0,
            allowed: true,
            overage: "block" as const,
            resets: "never" as const,
            resetsAt: null,
          },
        },
      };
      yield* log.upsertReadModel(metered);
      const read = yield* log.readModel("acct_1");
      // The card, the credits this feature spent, and the shared pool it
      // reports all survive the JSON column, so the edge prices a request
      // without reading the catalog.
      expect(read?.credits).toBe(49_000);
      expect(read?.features.ai?.creditRates).toEqual({ default: 1, "gpt-large": 10 });
      expect(read?.features.ai?.remaining).toBe(49_000);
      expect(read?.features.ai?.used).toBe(1_000);
      expect(read?.features.ai?.included).toBeNull();
      expect(read).toEqual(metered);
    }),
  );

  it.effect("refuses to read a corrupt read model", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* store;
      sql.run(
        "INSERT INTO billing_rm_billing_read (account, tier, status, standing, period_start, period_end, cancel_at_period_end, credits, dunning_attempts, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["acct_bad", "free", "active", "good", 0, 1, 0, 0, 0, '{"messages":{"included":"lots"}}'],
      );
      const exit = yield* Effect.exit(log.readModel("acct_bad"));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("normalizes numeric columns a driver returns as text", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* store;
      yield* append(log);
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
      const query = sql.query!;
      const stringy: SqlExecutor = {
        ...sql,
        query: (statement, params) =>
          Effect.map(query(statement, params), (rows) => rows.map(asText) as never),
      };
      const adapted = SqlEventLog(stringy, { now: () => 1_000 });
      expect((yield* adapted.events("Subscription", "acct_1")).map((row) => row.at)).toEqual([100]);
      expect((yield* adapted.pendingDeliveries()).map((row) => row.seq)).toEqual([1]);
      expect(yield* append(adapted)).toEqual({ version: 1, duplicate: true, conflict: false });

      yield* log.upsertReadModel({
        ...readModelRow,
        features: { messages: readModelRow.features.messages },
      });
      expect((yield* adapted.readModel("acct_1"))?.periodEnd).toEqual(later);
    }),
  );

  it.effect("lists every account with events", () =>
    Effect.gen(function* () {
      const { log } = yield* store;
      for (const [index, account] of ["acct_b", "acct_a", "acct_a"].entries()) {
        yield* append(log, { account, commandId: `cmd_${account}_${index}` });
      }
      expect(yield* log.accounts("Subscription")).toEqual(["acct_a", "acct_b"]);
    }),
  );
});
