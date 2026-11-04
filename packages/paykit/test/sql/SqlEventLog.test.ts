import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { migrate } from "../../src/Migrations/index.ts";
import { SqlEventLog } from "../../src/Store/SqlEventLog.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const later = DateTime.makeUnsafe("2030-02-01T00:00:00Z");

const store = () => {
  const sql = sqliteExecutor();
  Effect.runSync(migrate(sql, () => 0));
  return { sql, log: SqlEventLog(sql, () => 1_000) };
};

describe("SqlEventLog", () => {
  it("appends events, state and receipt atomically, then dedupes the command", () => {
    const { sql, log } = store();
    const first = log.append({
      aggregate: "Subscription",
      account: "acct_1",
      commandId: "cmd_1",
      at: 100,
      events: [{ _tag: "Opened", n: 1 }],
      state: { _tag: "Opened", n: 1 },
      receipt: { version: 1 },
      deliveries: [{ target: "Entitlements" }],
    });
    expect(first).toEqual({ version: 1, duplicate: false });

    const again = log.append({
      aggregate: "Subscription",
      account: "acct_1",
      commandId: "cmd_1",
      at: 100,
      events: [{ _tag: "Opened", n: 1 }],
      state: { _tag: "Opened", n: 1 },
      receipt: { version: 1 },
      deliveries: [{ target: "Entitlements" }],
    });
    expect(again).toEqual({ version: 1, duplicate: true });
    expect(log.events("Subscription", "acct_1").length).toBe(1);
    expect(log.pendingDeliveries().length).toBe(1);

    const second = log.append({
      aggregate: "Subscription",
      account: "acct_1",
      commandId: "cmd_2",
      at: 200,
      events: [
        { _tag: "Used", n: 2 },
        { _tag: "Used", n: 3 },
      ],
      state: { _tag: "Opened", n: 3 },
      receipt: { version: 3 },
      deliveries: [{ target: "Entitlements" }],
    });
    expect(second).toEqual({ version: 3, duplicate: false });
    expect(log.events("Subscription", "acct_1").map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(JSON.parse(log.state("Subscription", "acct_1")!.state)).toEqual({
      _tag: "Opened",
      n: 3,
    });
    expect(sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM billing_outbox")?.count).toBe(
      3,
    );
  });

  it("drains the outbox", () => {
    const { log } = store();
    log.append({
      aggregate: "Subscription",
      account: "acct_1",
      commandId: "cmd_1",
      at: 100,
      events: [{ _tag: "Opened" }],
      state: {},
      receipt: {},
      deliveries: [{ target: "Entitlements" }, { target: "BillingRead" }],
    });
    const pending = log.pendingDeliveries();
    expect(pending.length).toBe(2);
    for (const delivery of pending) log.markDelivered(delivery.seq);
    expect(log.pendingDeliveries().length).toBe(0);
  });

  it("schedules commands durably and reports the ones due", () => {
    const { log } = store();
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
  });

  it("upserts one read model row per account", () => {
    const { log } = store();
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
          remaining: 100,
          overage: "block" as const,
          resets: "month" as const,
          resetsAt: later,
        },
      },
    };
    log.upsertReadModel(row);
    expect(log.readModel("acct_1")).toEqual(row);
    log.upsertReadModel({ ...row, credits: 50 });
    expect(log.readModel("acct_1")?.credits).toBe(50);
    expect(log.readModelList().length).toBe(1);
    expect(log.readModel("missing")).toBe(null);
  });

  it("lists every account with events", () => {
    const { log } = store();
    for (const account of ["acct_b", "acct_a"]) {
      log.append({
        aggregate: "Subscription",
        account,
        commandId: `cmd_${account}`,
        at: 1,
        events: [{ _tag: "Opened" }],
        state: {},
        receipt: {},
        deliveries: [],
      });
    }
    expect(log.accounts("Subscription")).toEqual(["acct_a", "acct_b"]);
  });
});
