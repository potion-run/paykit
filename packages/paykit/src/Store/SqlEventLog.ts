import * as DateTime from "effect/DateTime";
import type { BillingReadRow } from "../BillingReadStore.ts";
import type { SqlExecutor } from "./Sql.ts";

/** One committed event, as the log stores it. `event` is JSON. */
export interface StoredEventRow {
  readonly aggregate: string;
  readonly account: string;
  readonly seq: number;
  readonly commandId: string;
  readonly at: number;
  readonly event: string;
}

/** What one accepted command writes, atomically. */
export interface AppendInput {
  readonly aggregate: string;
  readonly account: string;
  readonly commandId: string;
  readonly at: number;
  readonly events: ReadonlyArray<unknown>;
  readonly state: unknown;
  readonly receipt: unknown;
  readonly deliveries: ReadonlyArray<unknown>;
}

export interface AppendResult {
  readonly version: number;
  readonly duplicate: boolean;
}

export interface PendingDelivery {
  readonly seq: number;
  readonly aggregate: string;
  readonly account: string;
  readonly eventSeq: number;
  readonly delivery: string;
}

export interface ScheduledCommand {
  readonly aggregate: string;
  readonly account: string;
  readonly commandId: string;
  readonly dueAt: number;
  readonly command: string;
}

/**
 * The durable half of the store: events are the truth, receipts dedupe by
 * command id, the outbox carries deliveries, and the read model is
 * rebuildable. Every write for one account happens under its lock in one
 * transaction.
 */
export const SqlEventLog = (sql: SqlExecutor, now: () => number) => ({
  append: (input: AppendInput): AppendResult =>
    sql.transaction(() => {
      sql.lock(input.account);
      const seen = sql.get<{ version: number }>(
        "SELECT version FROM billing_receipt WHERE aggregate = ? AND account = ? AND command_id = ?",
        [input.aggregate, input.account, input.commandId],
      );
      if (seen !== undefined) return { version: seen.version, duplicate: true };

      const current = sql.get<{ version: number }>(
        "SELECT version FROM billing_state WHERE aggregate = ? AND account = ?",
        [input.aggregate, input.account],
      );
      let version = current?.version ?? 0;
      for (const event of input.events) {
        version += 1;
        sql.run(
          "INSERT INTO billing_event (aggregate, account, seq, command_id, at, event) VALUES (?, ?, ?, ?, ?, ?)",
          [
            input.aggregate,
            input.account,
            version,
            input.commandId,
            input.at,
            JSON.stringify(event),
          ],
        );
        for (const delivery of input.deliveries) {
          const next = sql.get<{ seq: number }>(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM billing_outbox",
          );
          sql.run(
            "INSERT INTO billing_outbox (seq, aggregate, account, event_seq, delivery) VALUES (?, ?, ?, ?, ?)",
            [next?.seq ?? 1, input.aggregate, input.account, version, JSON.stringify(delivery)],
          );
        }
      }

      sql.run(
        `INSERT INTO billing_state (aggregate, account, version, state) VALUES (?, ?, ?, ?)
         ON CONFLICT (aggregate, account) DO UPDATE SET version = excluded.version, state = excluded.state`,
        [input.aggregate, input.account, version, JSON.stringify(input.state)],
      );
      sql.run(
        "INSERT INTO billing_receipt (aggregate, account, command_id, version, receipt) VALUES (?, ?, ?, ?, ?)",
        [input.aggregate, input.account, input.commandId, version, JSON.stringify(input.receipt)],
      );
      return { version, duplicate: false };
    }),

  events: (aggregate: string, account: string, after = 0): ReadonlyArray<StoredEventRow> =>
    sql.all<StoredEventRow>(
      "SELECT aggregate, account, seq, command_id AS commandId, at, event FROM billing_event WHERE aggregate = ? AND account = ? AND seq > ? ORDER BY seq ASC",
      [aggregate, account, after],
    ),

  state: (aggregate: string, account: string) =>
    sql.get<{ version: number; state: string }>(
      "SELECT version, state FROM billing_state WHERE aggregate = ? AND account = ?",
      [aggregate, account],
    ),

  accounts: (aggregate: string): ReadonlyArray<string> =>
    sql
      .all<{ account: string }>(
        "SELECT DISTINCT account FROM billing_event WHERE aggregate = ? ORDER BY account ASC",
        [aggregate],
      )
      .map((row) => row.account),

  pendingDeliveries: (limit = 100): ReadonlyArray<PendingDelivery> =>
    sql.all<PendingDelivery>(
      "SELECT seq, aggregate, account, event_seq AS eventSeq, delivery FROM billing_outbox WHERE delivered_at IS NULL ORDER BY seq ASC LIMIT ?",
      [limit],
    ),

  markDelivered: (seq: number): void => {
    sql.run("UPDATE billing_outbox SET delivered_at = ? WHERE seq = ?", [now(), seq]);
  },

  schedule: (input: ScheduledCommand): void => {
    sql.run(
      `INSERT INTO billing_schedule (aggregate, account, command_id, due_at, command) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (aggregate, account, command_id) DO UPDATE SET due_at = excluded.due_at, command = excluded.command, delivered_at = NULL`,
      [input.aggregate, input.account, input.commandId, input.dueAt, input.command],
    );
  },

  unschedule: (aggregate: string, account: string, commandId: string): void => {
    sql.run("DELETE FROM billing_schedule WHERE aggregate = ? AND account = ? AND command_id = ?", [
      aggregate,
      account,
      commandId,
    ]);
  },

  due: (now: number): ReadonlyArray<ScheduledCommand> =>
    sql.all<ScheduledCommand>(
      "SELECT aggregate, account, command_id AS commandId, due_at AS dueAt, command FROM billing_schedule WHERE delivered_at IS NULL AND due_at <= ? ORDER BY due_at ASC",
      [now],
    ),

  markScheduledDelivered: (aggregate: string, account: string, commandId: string): void => {
    sql.run(
      "UPDATE billing_schedule SET delivered_at = ? WHERE aggregate = ? AND account = ? AND command_id = ?",
      [now(), aggregate, account, commandId],
    );
  },

  readModel: (account: string): BillingReadRow | null => {
    const row = sql.get<{
      account: string;
      tier: string;
      status: string;
      standing: string;
      period_start: number;
      period_end: number;
      cancel_at_period_end: number;
      credits: number;
      currency: string | null;
      features: string;
    }>("SELECT * FROM billing_rm_billing_read WHERE account = ?", [account]);
    return row === undefined ? null : rowToReadModel(row);
  },

  readModelList: (): ReadonlyArray<BillingReadRow> =>
    sql
      .all<{
        account: string;
        tier: string;
        status: string;
        standing: string;
        period_start: number;
        period_end: number;
        cancel_at_period_end: number;
        credits: number;
        currency: string | null;
        features: string;
      }>("SELECT * FROM billing_rm_billing_read ORDER BY account ASC")
      .map(rowToReadModel),

  upsertReadModel: (row: BillingReadRow): void => {
    sql.run(
      `INSERT INTO billing_rm_billing_read
        (account, tier, status, standing, period_start, period_end, cancel_at_period_end, credits, currency, features)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account) DO UPDATE SET
         tier = excluded.tier,
         status = excluded.status,
         standing = excluded.standing,
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         credits = excluded.credits,
         currency = excluded.currency,
         features = excluded.features`,
      [
        row.account,
        row.tier,
        row.status,
        row.standing,
        row.periodStart.epochMilliseconds,
        row.periodEnd.epochMilliseconds,
        row.cancelAtPeriodEnd ? 1 : 0,
        row.credits,
        row.currency ?? null,
        featuresJson(row.features),
      ],
    );
  },
});

export type SqlEventLog = ReturnType<typeof SqlEventLog>;

const rowToReadModel = (row: {
  account: string;
  tier: string;
  status: string;
  standing: string;
  period_start: number;
  period_end: number;
  cancel_at_period_end: number;
  credits: number;
  currency: string | null;
  features: string;
}): BillingReadRow => ({
  account: row.account,
  tier: row.tier,
  status: row.status as BillingReadRow["status"],
  standing: row.standing as BillingReadRow["standing"],
  periodStart: dateTimeFrom(row.period_start),
  periodEnd: dateTimeFrom(row.period_end),
  cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  credits: row.credits,
  ...(row.currency === null ? {} : { currency: row.currency }),
  features: decodeFeatures(row.features),
});

const dateTimeFrom = (millis: number): DateTime.Utc => DateTime.makeUnsafe(millis);

const featuresJson = (features: BillingReadRow["features"]): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(features).map(([feature, value]) => [
        feature,
        {
          ...value,
          resetsAt: value.resetsAt === null ? null : value.resetsAt.epochMilliseconds,
        },
      ]),
    ),
  );

const decodeFeatures = (json: string): BillingReadRow["features"] =>
  Object.fromEntries(
    Object.entries(
      JSON.parse(json) as Record<
        string,
        Omit<BillingReadRow["features"][string], "resetsAt"> & { resetsAt: number | null }
      >,
    ).map(([feature, value]) => [
      feature,
      {
        ...value,
        resetsAt: value.resetsAt === null ? null : dateTimeFrom(value.resetsAt),
      },
    ]),
  ) as BillingReadRow["features"];
