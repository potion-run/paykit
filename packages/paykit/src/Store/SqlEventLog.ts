import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { BillingReadRow } from "../BillingReadStore.ts";
import type { SqlExecutor } from "./Sql.ts";
import { BILLING_TABLES, DEFAULT_SCHEMA, tableName, type TableScope } from "./Tables.ts";

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

/** Everything the store needs beyond the executor itself. */
export interface SqlEventLogOptions {
  /**
   * Timestamp source for outbox and schedule bookkeeping. Callers inject it
   * so the store has no ambient clock; tests pass a constant.
   */
  readonly now: () => number;
  /**
   * The Postgres schema holding every `billing_*` table. Defaults to
   * `billing`; SQLite ignores it.
   */
  readonly schema?: string;
}

/**
 * The durable half of the store: events are the truth, receipts dedupe by
 * command id, the outbox carries deliveries, and the read model is
 * rebuildable. Every write for one account happens under its lock in one
 * transaction.
 *
 * @primitive
 * @example
 * ```ts
 * import { SqlEventLog } from "@potion.run/paykit"
 *
 * const log = SqlEventLog(sql, { now: () => 1_700_000_000_000, schema: "billing" })
 * const { version } = log.append({ ... })
 * ```
 */
export const SqlEventLog = (sql: SqlExecutor, options: SqlEventLogOptions) => {
  const scope: TableScope = {
    dialect: sql.dialect,
    schema: options.schema ?? DEFAULT_SCHEMA,
  };
  const event = tableName(BILLING_TABLES.event, scope);
  const receiptTable = tableName(BILLING_TABLES.receipt, scope);
  const state = tableName(BILLING_TABLES.state, scope);
  const outbox = tableName(BILLING_TABLES.outbox, scope);
  const schedule = tableName(BILLING_TABLES.schedule, scope);
  const readModels = tableName(BILLING_TABLES.readModel, scope);

  return {
    append: (input: AppendInput): AppendResult =>
      sql.transaction(() => {
        sql.lock(input.account);
        const seen = sql.get<{ version: number | string }>(
          `SELECT version FROM ${receiptTable} WHERE aggregate = ? AND account = ? AND command_id = ?`,
          [input.aggregate, input.account, input.commandId],
        );
        if (seen !== undefined) return { version: numberFrom(seen.version), duplicate: true };

        // The event log is the truth: the next sequence comes from it, not
        // from a cached counter that a crash could leave stale.
        const current = sql.get<{ version: number | string }>(
          `SELECT COALESCE(MAX(seq), 0) AS version FROM ${event} WHERE aggregate = ? AND account = ?`,
          [input.aggregate, input.account],
        );
        let version = numberFrom(current?.version ?? 0);
        let outboxSeq = numberFrom(
          sql.get<{ seq: number | string }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${outbox}`)
            ?.seq ?? 0,
        );

        for (const record of input.events) {
          version += 1;
          sql.run(
            `INSERT INTO ${event} (aggregate, account, seq, command_id, at, event) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              input.aggregate,
              input.account,
              version,
              input.commandId,
              input.at,
              JSON.stringify(record),
            ],
          );
          for (const delivery of input.deliveries) {
            outboxSeq += 1;
            sql.run(
              `INSERT INTO ${outbox} (seq, aggregate, account, event_seq, delivery) VALUES (?, ?, ?, ?, ?)`,
              [outboxSeq, input.aggregate, input.account, version, JSON.stringify(delivery)],
            );
          }
        }

        sql.run(
          `INSERT INTO ${state} (aggregate, account, version, state) VALUES (?, ?, ?, ?)
           ON CONFLICT (aggregate, account) DO UPDATE SET version = excluded.version, state = excluded.state`,
          [input.aggregate, input.account, version, JSON.stringify(input.state)],
        );
        sql.run(
          `INSERT INTO ${receiptTable} (aggregate, account, command_id, version, receipt) VALUES (?, ?, ?, ?, ?)`,
          [input.aggregate, input.account, input.commandId, version, JSON.stringify(input.receipt)],
        );
        return { version, duplicate: false };
      }),

    events: (aggregate: string, account: string, after = 0): ReadonlyArray<StoredEventRow> =>
      sql
        .all<StoredEventRow>(
          `SELECT aggregate, account, seq, command_id AS commandId, at, event FROM ${event} WHERE aggregate = ? AND account = ? AND seq > ? ORDER BY seq ASC`,
          [aggregate, account, after],
        )
        .map((row) => ({ ...row, seq: numberFrom(row.seq), at: numberFrom(row.at) })),

    /** The receipt a command id already produced, as JSON, if it ran. */
    receipt: (aggregate: string, account: string, commandId: string): string | undefined =>
      sql.get<{ receipt: string }>(
        `SELECT receipt FROM ${receiptTable} WHERE aggregate = ? AND account = ? AND command_id = ?`,
        [aggregate, account, commandId],
      )?.receipt,

    /** A pending scheduled command, if one is waiting under this command id. */
    pendingFor: (
      aggregate: string,
      account: string,
      commandId: string,
    ): { readonly dueAt: number; readonly command: string } | undefined => {
      const row = sql.get<{ dueAt: number | string; command: string }>(
        `SELECT due_at AS dueAt, command FROM ${schedule} WHERE aggregate = ? AND account = ? AND command_id = ? AND delivered_at IS NULL`,
        [aggregate, account, commandId],
      );
      return row === undefined ? undefined : { dueAt: numberFrom(row.dueAt), command: row.command };
    },

    state: (aggregate: string, account: string) =>
      sql.get<{ version: number; state: string }>(
        `SELECT version, state FROM ${state} WHERE aggregate = ? AND account = ?`,
        [aggregate, account],
      ),

    accounts: (aggregate: string): ReadonlyArray<string> =>
      sql
        .all<{ account: string }>(
          `SELECT DISTINCT account FROM ${event} WHERE aggregate = ? ORDER BY account ASC`,
          [aggregate],
        )
        .map((row) => row.account),

    pendingDeliveries: (limit = 100): ReadonlyArray<PendingDelivery> =>
      sql
        .all<PendingDelivery>(
          `SELECT seq, aggregate, account, event_seq AS eventSeq, delivery FROM ${outbox} WHERE delivered_at IS NULL ORDER BY seq ASC LIMIT ?`,
          [limit],
        )
        .map((row) => ({ ...row, seq: numberFrom(row.seq), eventSeq: numberFrom(row.eventSeq) })),

    markDelivered: (seq: number): void => {
      sql.run(`UPDATE ${outbox} SET delivered_at = ? WHERE seq = ?`, [options.now(), seq]);
    },

    schedule: (input: ScheduledCommand): void => {
      sql.run(
        `INSERT INTO ${schedule} (aggregate, account, command_id, due_at, command) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (aggregate, account, command_id) DO UPDATE SET due_at = excluded.due_at, command = excluded.command, delivered_at = NULL`,
        [input.aggregate, input.account, input.commandId, input.dueAt, input.command],
      );
    },

    unschedule: (aggregate: string, account: string, commandId: string): void => {
      sql.run(`DELETE FROM ${schedule} WHERE aggregate = ? AND account = ? AND command_id = ?`, [
        aggregate,
        account,
        commandId,
      ]);
    },

    due: (now: number): ReadonlyArray<ScheduledCommand> =>
      sql
        .all<ScheduledCommand>(
          `SELECT aggregate, account, command_id AS commandId, due_at AS dueAt, command FROM ${schedule} WHERE delivered_at IS NULL AND due_at <= ? ORDER BY due_at ASC`,
          [now],
        )
        .map((row) => ({ ...row, dueAt: numberFrom(row.dueAt) })),

    markScheduledDelivered: (aggregate: string, account: string, commandId: string): void => {
      sql.run(
        `UPDATE ${schedule} SET delivered_at = ? WHERE aggregate = ? AND account = ? AND command_id = ?`,
        [options.now(), aggregate, account, commandId],
      );
    },

    readModel: (account: string): BillingReadRow | null => {
      const row = sql.get<ReadModelColumns>(
        `SELECT ${READ_MODEL_COLUMNS} FROM ${readModels} WHERE account = ?`,
        [account],
      );
      return row === undefined ? null : rowToReadModel(row);
    },

    readModelList: (): ReadonlyArray<BillingReadRow> =>
      sql
        .all<ReadModelColumns>(
          `SELECT ${READ_MODEL_COLUMNS} FROM ${readModels} ORDER BY account ASC`,
        )
        .map(rowToReadModel),

    upsertReadModel: (row: BillingReadRow): void => {
      sql.run(
        `INSERT INTO ${readModels}
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
  };
};

export type SqlEventLog = ReturnType<typeof SqlEventLog>;

const READ_MODEL_COLUMNS =
  "account, tier, status, standing, period_start, period_end, cancel_at_period_end, credits, currency, features";

interface ReadModelColumns {
  readonly account: string;
  readonly tier: string;
  readonly status: string;
  readonly standing: string;
  /** A driver may return BIGINT as text; `numberFrom` normalizes it. */
  readonly period_start: number | string;
  readonly period_end: number | string;
  readonly cancel_at_period_end: number | string;
  readonly credits: number | string;
  readonly currency: string | null;
  readonly features: string;
}

const rowToReadModel = (row: ReadModelColumns): BillingReadRow =>
  Schema.decodeUnknownSync(BillingReadRow)({
    account: row.account,
    tier: row.tier,
    status: row.status,
    standing: row.standing,
    periodStart: dateTimeFrom(numberFrom(row.period_start)),
    periodEnd: dateTimeFrom(numberFrom(row.period_end)),
    cancelAtPeriodEnd: numberFrom(row.cancel_at_period_end) === 1,
    credits: numberFrom(row.credits),
    ...(row.currency === null ? {} : { currency: row.currency }),
    features: decodeFeatures(row.features),
  });

const numberFrom = (value: number | string): number =>
  typeof value === "number" ? value : Number(value);

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
