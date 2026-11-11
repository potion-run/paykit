import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  DEFAULT_PAGE,
  MAX_PAGE,
  type BillingReadQuery,
  type BillingReadRow,
  type BillingReadSummary,
} from "../BillingReadStore.ts";
import {
  BillingReadRow as BillingReadRowSchema,
  BillingReadSummary as BillingReadSummarySchema,
  usageLimitedOf,
} from "../BillingReadStore.ts";
import type { CustomerDetails } from "../Customer.ts";
import type { EntityEntitlement, FeatureEntitlement } from "../Subscription/Entitlements.view.ts";
import { asyncOf, type SqlDialect, type SqlError, type SqlExecutor, type SqlValue } from "./Sql.ts";
import { BILLING_TABLES, DEFAULT_SCHEMA, tableName, type TableScope } from "./Tables.ts";
import { insertIgnoring, upsertRow } from "./Upsert.ts";

/** One committed event, as a row. */
export interface StoredEventRow {
  readonly aggregate: string;
  readonly account: string;
  readonly seq: number;
  readonly commandId: string;
  readonly at: number;
  readonly event: string;
}

/** What one append writes: the events, the state after them, and the receipt. */
export interface AppendInput {
  readonly aggregate: string;
  readonly account: string;
  readonly commandId: string;
  readonly at: number;
  readonly events: ReadonlyArray<unknown>;
  readonly state: unknown;
  readonly receipt: unknown;
  readonly deliveries: ReadonlyArray<unknown>;
  /**
   * The version the caller decided on. When present, an append whose instance
   * has moved past it writes nothing and reports `conflict`, so a decision
   * taken on a snapshot another writer already spent cannot land. Omit it only
   * for a write that needs no such check — a seed, a fixture, a migration.
   */
  readonly expectedVersion?: number;
}

export interface AppendResult {
  readonly version: number;
  readonly duplicate: boolean;
  /** The instance moved past `expectedVersion`; nothing was written. */
  readonly conflict: boolean;
}

/** A delivery the outbox is still carrying. */
export interface PendingDelivery {
  readonly seq: number;
  readonly aggregate: string;
  readonly account: string;
  readonly eventSeq: number;
  readonly delivery: string;
}

/** A scheduled command that has not fired. */
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
 * rebuildable.
 *
 * Every method is an `Effect`: a statement's answer arrives asynchronously on
 * every target worth supporting (D1 over HTTP, a `pg` client), and a store that
 * pretends otherwise cannot reach one. `append` runs as one `atomic` unit, so
 * the events, the state, the receipt and the deliveries land together or not
 * at all.
 *
 * @primitive
 * @example
 * ```ts
 * import { SqlEventLog } from "@potion.run/paykit"
 *
 * const log = SqlEventLog(sql, { now: () => 1_700_000_000_000, schema: "billing" })
 * const { version } = yield* log.append({ ... })
 * ```
 */
export const SqlEventLog = (executor: SqlExecutor, options: SqlEventLogOptions) => {
  const sql = asyncOf(executor);

  const scope: TableScope = {
    dialect: executor.dialect,
    schema: options.schema ?? DEFAULT_SCHEMA,
  };

  const event = tableName(BILLING_TABLES.event, scope);
  const receipt = tableName(BILLING_TABLES.receipt, scope);
  const state = tableName(BILLING_TABLES.state, scope);
  const outbox = tableName(BILLING_TABLES.outbox, scope);
  const schedule = tableName(BILLING_TABLES.schedule, scope);
  const readModels = tableName(BILLING_TABLES.readModel, scope);

  // Claim the instance's state row, then lock it. On Postgres `FOR UPDATE`
  // serializes two writers of one account; SQLite's `BEGIN IMMEDIATE` already
  // does. Without the lock both would read the same `MAX(seq)` and one would
  // fail on the primary key instead of taking the next sequence.
  const claim = insertIgnoring(executor.dialect, state, [
    "aggregate",
    "account",
    "version",
    "state",
  ]);

  /** A write lost a primary-key race: another writer claimed the same row. */
  const uniqueViolation = (error: SqlError): boolean => {
    // SAFETY: an error cause and a stored JSON row are untyped at the storage boundary; the event log's schema owns the value.
    const cause = error.cause as
      | { readonly code?: unknown; readonly message?: unknown }
      | undefined;

    const asText = (value: unknown): string =>
      typeof value === "string" ? value : value === undefined ? "" : (JSON.stringify(value) ?? "");

    const text = `${error.message} ${asText(cause?.code)} ${asText(cause?.message)}`.toLowerCase();

    return (
      text.includes("unique constraint") ||
      text.includes("duplicate key") ||
      text.includes("sqlite_constraint") ||
      text.includes("unique_violation")
    );
  };

  const append = (input: AppendInput) =>
    sql
      .atomic(
        Effect.gen(function* () {
          yield* sql.write(claim, [input.aggregate, input.account, 0, "null"]);
          yield* sql.get(
            executor.dialect === "postgres"
              ? `SELECT version FROM ${state} WHERE aggregate = ? AND account = ? FOR UPDATE`
              : `SELECT version FROM ${state} WHERE aggregate = ? AND account = ?`,
            [input.aggregate, input.account],
          );

          // The receipt is re-read under the lock: a duplicate that raced this
          // commit waited for it, so it sees the first receipt instead of both
          // writers deciding the same command.
          const seen = yield* sql.get<{ version: number | string }>(
            `SELECT version FROM ${receipt} WHERE aggregate = ? AND account = ? AND command_id = ?`,
            [input.aggregate, input.account, input.commandId],
          );

          if (seen !== undefined) {
            return { version: numberFrom(seen.version), duplicate: true, conflict: false };
          }

          // The event log is the truth: the next sequence comes from it, not
          // from a cached counter that a crash could leave stale. Reading it is
          // also where a decision taken on a snapshot another writer spent is
          // caught: the log has moved, so this decision is about a state that is
          // no longer the instance's, and writing it would publish a number the
          // events do not add up to.
          const current = yield* sql.get<{ version: number | string }>(
            `SELECT COALESCE(MAX(seq), 0) AS version FROM ${event} WHERE aggregate = ? AND account = ?`,
            [input.aggregate, input.account],
          );

          let version = numberFrom(current?.version ?? 0);

          if (input.expectedVersion !== undefined && version !== input.expectedVersion) {
            return { version, duplicate: false, conflict: true };
          }

          for (const record of input.events) {
            version += 1;
            yield* sql.write(
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
              // `seq` is allocated by the database (see migration 0003), so two
              // accounts committing at once never share a maximum.
              yield* sql.write(
                `INSERT INTO ${outbox} (aggregate, account, event_seq, delivery) VALUES (?, ?, ?, ?)`,
                [input.aggregate, input.account, version, JSON.stringify(delivery)],
              );
            }
          }

          yield* sql.write(
            upsertRow(
              executor.dialect,
              state,
              ["aggregate", "account", "version", "state"],
              ["aggregate", "account"],
            ),
            [input.aggregate, input.account, version, JSON.stringify(input.state)],
          );
          yield* sql.write(
            `INSERT INTO ${receipt} (aggregate, account, command_id, version, receipt) VALUES (?, ?, ?, ?, ?)`,
            [
              input.aggregate,
              input.account,
              input.commandId,
              version,
              JSON.stringify(input.receipt),
            ],
          );

          return { version, duplicate: false, conflict: false };
        }),
      )
      .pipe(
        // D1's deferred isolation and a Postgres writer that raced the lock can
        // still reach a primary key first. That is the same condition as a
        // version conflict: the caller re-reads and decides again.
        Effect.catchTag("SqlError", (error) =>
          uniqueViolation(error)
            ? Effect.succeed({ version: 0, duplicate: false, conflict: true })
            : Effect.fail(error),
        ),
      );

  return {
    append,

    events: (aggregate: string, account: string, after = 0) =>
      Effect.map(
        sql.query<StoredEventRow>(
          `SELECT aggregate, account, seq, command_id AS commandId, at, event FROM ${event} WHERE aggregate = ? AND account = ? AND seq > ? ORDER BY seq ASC`,
          [aggregate, account, after],
        ),
        (rows) => rows.map((row) => ({ ...row, seq: numberFrom(row.seq), at: numberFrom(row.at) })),
      ),

    /** The receipt a command id already produced, as JSON, if it ran. */
    receipt: (aggregate: string, account: string, commandId: string) =>
      Effect.map(
        sql.get<{ receipt: string }>(
          `SELECT receipt FROM ${receipt} WHERE aggregate = ? AND account = ? AND command_id = ?`,
          [aggregate, account, commandId],
        ),
        (row) => row?.receipt,
      ),

    /** A pending scheduled command, if one is waiting under this command id. */
    pendingFor: (aggregate: string, account: string, commandId: string) =>
      Effect.map(
        sql.get<{ dueAt: number | string; command: string }>(
          `SELECT due_at AS dueAt, command FROM ${schedule} WHERE aggregate = ? AND account = ? AND command_id = ? AND delivered_at IS NULL`,
          [aggregate, account, commandId],
        ),
        (row) =>
          row === undefined ? undefined : { dueAt: numberFrom(row.dueAt), command: row.command },
      ),

    state: (aggregate: string, account: string) =>
      sql.get<{ version: number; state: string }>(
        `SELECT version, state FROM ${state} WHERE aggregate = ? AND account = ?`,
        [aggregate, account],
      ),

    accounts: (aggregate: string) =>
      Effect.map(
        sql.query<{ account: string }>(
          `SELECT DISTINCT account FROM ${event} WHERE aggregate = ? ORDER BY account ASC`,
          [aggregate],
        ),
        (rows) => rows.map((row) => row.account),
      ),

    /**
     * One page of undelivered outbox rows, oldest first. The filter is part of
     * the query, not a caller's JS pass: a caller draining one instance must
     * not read every other account's backlog to find its own rows.
     */
    pendingDeliveries: (
      limit = 100,
      filter?: { readonly aggregate?: string; readonly account?: string },
    ) => {
      const where = ["delivered_at IS NULL"];
      const params: Array<SqlValue> = [];

      if (filter?.aggregate !== undefined) {
        where.push("aggregate = ?");
        params.push(filter.aggregate);
      }

      if (filter?.account !== undefined) {
        where.push("account = ?");
        params.push(filter.account);
      }

      return Effect.map(
        sql.query<PendingDelivery>(
          `SELECT seq, aggregate, account, event_seq AS eventSeq, delivery FROM ${outbox} WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
          [...params, limit],
        ),
        (rows) =>
          rows.map((row) => ({
            ...row,
            seq: numberFrom(row.seq),
            eventSeq: numberFrom(row.eventSeq),
          })),
      );
    },

    markDelivered: (seq: number) =>
      sql.write(`UPDATE ${outbox} SET delivered_at = ? WHERE seq = ?`, [options.now(), seq]),

    schedule: (input: ScheduledCommand) =>
      sql.write(
        upsertRow(
          executor.dialect,
          schedule,
          ["aggregate", "account", "command_id", "due_at", "command"],
          ["aggregate", "account", "command_id"],
          { reset: ["delivered_at"] },
        ),
        [input.aggregate, input.account, input.commandId, input.dueAt, input.command],
      ),

    unschedule: (aggregate: string, account: string, commandId: string) =>
      sql.write(`DELETE FROM ${schedule} WHERE aggregate = ? AND account = ? AND command_id = ?`, [
        aggregate,
        account,
        commandId,
      ]),

    due: (now: number) =>
      Effect.map(
        sql.query<ScheduledCommand>(
          `SELECT aggregate, account, command_id AS commandId, due_at AS dueAt, command FROM ${schedule} WHERE delivered_at IS NULL AND due_at <= ? ORDER BY due_at ASC`,
          [now],
        ),
        (rows) => rows.map((row) => ({ ...row, dueAt: numberFrom(row.dueAt) })),
      ),

    markScheduledDelivered: (aggregate: string, account: string, commandId: string) =>
      sql.write(
        `UPDATE ${schedule} SET delivered_at = ? WHERE aggregate = ? AND account = ? AND command_id = ?`,
        [options.now(), aggregate, account, commandId],
      ),

    readModel: (account: string) =>
      Effect.flatMap(
        sql.get<ReadModelColumns>(
          `SELECT ${READ_MODEL_COLUMNS} FROM ${readModels} WHERE account = ?`,
          [account],
        ),
        (row) => (row === undefined ? Effect.succeed(null) : rowToReadModel(row)),
      ),

    /**
     * One page of accounts, pushed down to SQL: the filter, the cursor and the
     * limit are the query, so a dashboard does not read the whole projection to
     * show fifty rows.
     */
    readModelPage: (query: BillingReadQuery = {}) => {
      const order = query.order ?? "asc";
      const take = Math.min(MAX_PAGE, Math.max(1, query.take ?? DEFAULT_PAGE));
      const where: Array<string> = [];
      const params: Array<SqlValue> = [];

      if (query.standing !== undefined) {
        where.push("standing = ?");
        params.push(query.standing);
      }

      if (query.tier !== undefined) {
        where.push("tier = ?");
        params.push(query.tier);
      }

      if (query.status !== undefined) {
        where.push("status = ?");
        params.push(query.status);
      }

      const search = query.search?.trim().toLowerCase();

      if (search !== undefined && search !== "") {
        // The memory store matches the needle literally against the account id
        // and the customer's name and email. Escape LIKE's own wildcards, and
        // read the two fields out of the customer JSON instead of matching the
        // JSON keys themselves (`"name"` would otherwise match every row).
        const needle = `%${search.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;

        const field = (name: "name" | "email"): string =>
          Match.value(executor.dialect).pipe(
            Match.withReturnType<string>(),
            Match.when("postgres", () => `LOWER((customer::jsonb) ->> '${name}')`),
            Match.when("mysql", () => `LOWER(JSON_UNQUOTE(JSON_EXTRACT(customer, '$.${name}')))`),
            Match.orElse(() => `LOWER(json_extract(customer, '$.${name}'))`),
          );

        const name = field("name");
        const email = field("email");

        where.push(
          `(LOWER(account) LIKE ? ESCAPE '!' OR ${name} LIKE ? ESCAPE '!' OR ${email} LIKE ? ESCAPE '!')`,
        );
        params.push(needle, needle, needle);
      }

      if (query.after !== undefined) {
        where.push(order === "asc" ? "account > ?" : "account < ?");
        params.push(query.after);
      }

      const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;

      return Effect.flatMap(
        sql.query<ReadModelColumns>(
          `SELECT ${READ_MODEL_COLUMNS} FROM ${readModels}${clause} ORDER BY account ${order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
          [...params, take + 1],
        ),
        (found) =>
          Effect.map(Effect.forEach(found.slice(0, take), rowToReadModel), (rows) => {
            const last = rows[rows.length - 1];

            return {
              rows,
              next: found.length > take && last !== undefined ? last.account : null,
            };
          }),
      );
    },

    readModelList: () =>
      Effect.flatMap(
        sql.query<ReadModelColumns>(
          `SELECT ${READ_MODEL_COLUMNS} FROM ${readModels} ORDER BY account ASC`,
        ),
        (rows) => Effect.forEach(rows, rowToReadModel),
      ),

    /**
     * The console's overview in one aggregate: how many accounts share each
     * `(tier, status, standing)` cell. A dashboard folds these counts instead
     * of reading the projection row by row.
     */
    readModelSummary: () =>
      Effect.flatMap(
        sql.query<SummaryColumns>(
          `SELECT tier, status, standing, COUNT(*) AS accounts FROM ${readModels} GROUP BY tier, status, standing ORDER BY tier ASC, status ASC, standing ASC`,
        ),
        (rows) => Effect.forEach(rows, summaryToReadModel),
      ),

    /**
     * The rows the overview's attention list can name, filtered in SQL so a
     * dashboard never reads the entire projection to find them. The reason
     * list and its order are folded in the console read.
     */
    readModelAttention: () =>
      Effect.flatMap(
        sql.query<ReadModelColumns>(
          `SELECT ${READ_MODEL_COLUMNS} FROM ${readModels} WHERE status NOT IN ('canceled', 'expired') AND (status = 'grace' OR cancel_at_period_end = 1 OR usage_limited = 1) ORDER BY account ASC`,
        ),
        (rows) => Effect.forEach(rows, rowToReadModel),
      ),

    upsertReadModel: (row: BillingReadRow) =>
      sql.write(
        upsertRow(
          executor.dialect,
          readModels,
          [
            "account",
            "tier",
            "status",
            "standing",
            "period_start",
            "period_end",
            "cancel_at_period_end",
            "credits",
            "prepaid_credits",
            "dunning_attempts",
            "proration",
            "proration_invoice",
            "currency",
            "features",
            "entities",
            "customer",
            "usage_limited",
          ],
          ["account"],
        ),
        [
          row.account,
          row.tier,
          row.status,
          row.standing,
          row.periodStart.epochMilliseconds,
          row.periodEnd.epochMilliseconds,
          row.cancelAtPeriodEnd ? 1 : 0,
          row.credits,
          row.prepaidCredits,
          row.dunningAttempts,
          row.proration === undefined ? null : JSON.stringify(row.proration),
          row.prorationInvoice ?? null,
          row.currency ?? null,
          featuresJson(row.features),
          row.entities === undefined ? null : entitiesJson(row.entities),
          row.customer === undefined ? null : customerJson(row.customer),
          usageLimitedOf(row) ? 1 : 0,
        ] satisfies ReadonlyArray<SqlValue>,
      ),

    /** The dialect this log speaks, so a caller can render DDL for it. */
    dialect: executor.dialect satisfies SqlDialect,
  };
};

export type SqlEventLog = ReturnType<typeof SqlEventLog>;

const READ_MODEL_COLUMNS =
  "account, customer, tier, status, standing, period_start, period_end, cancel_at_period_end, credits, prepaid_credits, dunning_attempts, proration, proration_invoice, currency, features, entities";

interface ReadModelColumns {
  readonly account: string;
  readonly customer: string | null;
  readonly tier: string;
  readonly status: string;
  readonly standing: string;
  /** A driver may return BIGINT as text; `numberFrom` normalizes it. */
  readonly period_start: number | string;
  readonly period_end: number | string;
  readonly cancel_at_period_end: number | string;
  readonly credits: number | string;
  readonly prepaid_credits: number | string;
  readonly dunning_attempts: number | string;
  readonly proration: string | null;
  readonly proration_invoice: string | null;
  readonly currency: string | null;
  readonly features: string;
  readonly entities: string | null;
}

// SAFETY: an error cause and a stored JSON row are untyped at the storage boundary; the event log's schema owns the value.
const decodeReadModelRow = Schema.decodeUnknownEffect(BillingReadRowSchema);

// SAFETY: a driver may return BIGINT as text, so the schema owns the count.
const decodeReadModelSummary = Schema.decodeUnknownEffect(BillingReadSummarySchema);

// SAFETY: an error cause and a stored JSON row are untyped at the storage boundary; the event log's schema owns the value.
const rowToReadModel = (row: ReadModelColumns): Effect.Effect<BillingReadRow> =>
  Effect.suspend(() =>
    decodeReadModelRow({
      account: row.account,
      ...(row.customer === null ? {} : { customer: customerFrom(row.customer) }),
      tier: row.tier,
      status: row.status,
      standing: row.standing,
      periodStart: dateTimeFrom(numberFrom(row.period_start)),
      periodEnd: dateTimeFrom(numberFrom(row.period_end)),
      cancelAtPeriodEnd: numberFrom(row.cancel_at_period_end) === 1,
      credits: numberFrom(row.credits),
      ...(row.prepaid_credits === null ? {} : { prepaidCredits: numberFrom(row.prepaid_credits) }),
      dunningAttempts: numberFrom(row.dunning_attempts),
      ...(row.proration === null ? {} : { proration: JSON.parse(row.proration) as never }),
      ...(row.proration_invoice === null ? {} : { prorationInvoice: row.proration_invoice }),
      ...(row.currency === null ? {} : { currency: row.currency }),
      features: decodeFeatures(row.features),
      ...(row.entities === null ? {} : { entities: entitiesFrom(row.entities) }),
    }),
  ).pipe(
    // A row this schema cannot read is a bug in the store, not a case a caller
    // can handle: the read-model port has no failure channel.
    Effect.orDie,
  );

const numberFrom = (value: number | string): number =>
  typeof value === "number" ? value : Number(value);

interface SummaryColumns {
  readonly tier: string;
  readonly status: string;
  readonly standing: string;
  /** A driver may return BIGINT as text; `numberFrom` normalizes it. */
  readonly accounts: number | string;
}

const summaryToReadModel = (row: SummaryColumns): Effect.Effect<BillingReadSummary> =>
  decodeReadModelSummary({
    tier: row.tier,
    status: row.status,
    standing: row.standing,
    accounts: numberFrom(row.accounts),
  }).pipe(
    // A grouping this schema cannot read is a bug in the store, not a case a
    // caller can handle: the read-model port has no failure channel.
    Effect.orDie,
  );

const dateTimeFrom = (millis: number): DateTime.Utc => DateTime.makeUnsafe(millis);

/** One feature row as the SQL column stores it: instants become millis. */
const featureWire = (value: FeatureEntitlement) => ({
  ...value,
  resetsAt: value.resetsAt === null ? null : value.resetsAt.epochMilliseconds,
  ...(value.grants === undefined
    ? {}
    : {
        grants: value.grants.map((grant) => ({
          ...grant,
          ...(grant.expiresAt === undefined
            ? {}
            : { expiresAt: grant.expiresAt.epochMilliseconds }),
        })),
      }),
});

/** One feature row as the read model carries it. */
const featureFromWire = (
  value: Omit<FeatureEntitlement, "resetsAt" | "grants"> & {
    readonly resetsAt: number | null;
    readonly grants?: ReadonlyArray<
      Omit<NonNullable<FeatureEntitlement["grants"]>[number], "expiresAt"> & {
        readonly expiresAt?: number;
      }
    >;
  },
): FeatureEntitlement => {
  const { resetsAt, grants, ...rest } = value;

  return {
    ...rest,
    resetsAt: resetsAt === null ? null : dateTimeFrom(resetsAt),
    ...(grants === undefined
      ? {}
      : {
          grants: grants.map(({ expiresAt, ...grant }) => ({
            ...grant,
            ...(expiresAt === undefined ? {} : { expiresAt: dateTimeFrom(expiresAt) }),
          })),
        }),
  };
};

const customerJson = (customer: CustomerDetails): string =>
  JSON.stringify({ ...customer, createdAt: customer.createdAt.epochMilliseconds });

const customerFrom = (json: string): CustomerDetails => {
  // SAFETY: the JSON is `customerJson`'s own output, in the wire shape below.
  const value = JSON.parse(json) as Omit<CustomerDetails, "createdAt"> & {
    readonly createdAt: number;
  };

  return { ...value, createdAt: dateTimeFrom(value.createdAt) };
};

const featuresJson = (features: BillingReadRow["features"]): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(features).map(([feature, value]) => [feature, featureWire(value)]),
    ),
  );

/**
 * The entity column: each scope's lifecycle and its own rows. The pooled source
 * is not duplicated here — it stays once in the customer's `features`.
 */
const entitiesJson = (entities: Readonly<Record<string, EntityEntitlement>>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(entities).map(([id, entity]) => [
        id,
        {
          ...entity,
          createdAt: entity.createdAt.epochMilliseconds,
          ...(entity.archivedAt === undefined
            ? {}
            : { archivedAt: entity.archivedAt.epochMilliseconds }),
          features: Object.fromEntries(
            Object.entries(entity.features).map(([feature, value]) => [
              feature,
              featureWire(value),
            ]),
          ),
        },
      ]),
    ),
  );

const entitiesFrom = (json: string): Readonly<Record<string, EntityEntitlement>> =>
  Object.fromEntries(
    Object.entries(
      // SAFETY: the JSON is `entitiesJson`'s own output, in the wire shape below.
      JSON.parse(json) as Record<
        string,
        Omit<EntityEntitlement, "createdAt" | "archivedAt" | "features"> & {
          readonly createdAt: number;
          readonly archivedAt?: number;
          readonly features: Readonly<Record<string, never>>;
        }
      >,
    ).map(([id, entity]): [string, EntityEntitlement] => {
      const { createdAt, archivedAt, features, ...rest } = entity;

      return [
        id,
        {
          ...rest,
          createdAt: dateTimeFrom(createdAt),
          ...(archivedAt === undefined ? {} : { archivedAt: dateTimeFrom(archivedAt) }),
          features: Object.fromEntries(
            Object.entries(features).map(([feature, value]) => [
              feature,
              // SAFETY: the value is one encoded feature row.
              featureFromWire(value as never),
            ]),
          ),
        },
      ];
    }),
  );

// SAFETY: an error cause and a stored JSON row are untyped at the storage boundary; the event log's schema owns the value.
const decodeFeatures = (json: string): BillingReadRow["features"] =>
  Object.fromEntries(
    Object.entries(JSON.parse(json) as Record<string, never>).map(([feature, value]) => [
      feature,
      // SAFETY: the value is one encoded feature row.
      featureFromWire(value as never),
    ]),
  ) as BillingReadRow["features"];
