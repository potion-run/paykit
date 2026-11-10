import { Database } from "bun:sqlite";
import { describe, expect, it } from "@alchemy.run/test";
import {
  BillingApi,
  BILLING_SCHEMA,
  catalog,
  Check,
  Entitlements,
  List,
  type D1Like,
  type D1Prepared,
  schemaStatementsOf,
  Subscription,
  type SqlValue,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { billingCatalog, free, messages } from "../src/catalog.ts";
import { billingOnSql } from "../src/SqlBilling.ts";
import { subscribeInput } from "./support.ts";

const account = Subscription.ref("acct_sql_example");
const asAccount = { headers: { "x-paykit-actor": account.id } };
const freeInput = Effect.runSync(subscribeInput(free));

/**
 * A prepared statement over `bun:sqlite`, carrying the SQL and the binds it
 * holds. `D1Prepared` declares the optional `sql`; the binds are the fake's own,
 * which is what `batch` replays.
 */
interface FakeStatement extends D1Prepared {
  readonly sql: string;
  readonly params: ReadonlyArray<SqlValue>;
  bind(...values: ReadonlyArray<SqlValue>): FakeStatement;
}

/** Whether a statement is this fake's, so `batch` can read back its binds. */
const isFake = (statement: D1Prepared): statement is FakeStatement => "params" in statement;

const statementOver = (
  database: Database,
  sql: string,
  params: ReadonlyArray<SqlValue>,
): FakeStatement => ({
  sql,
  params,
  all: <T = Record<string, unknown>>() =>
    Promise.resolve({ results: database.query<T, SqlValue[]>(sql).all(...params) }),
  bind: (...values) => statementOver(database, sql, values),
});

/**
 * A `D1Like` over a real SQLite database: the same shape a Worker's binding
 * has, so the wiring the Worker uses is what this test exercises.
 */
const d1Over = (database: Database): D1Like => ({
  prepare: (sql: string) => statementOver(database, sql, []),
  batch: async (statements) => {
    database.exec("BEGIN IMMEDIATE");

    try {
      for (const statement of statements) {
        if (!isFake(statement)) throw new Error("a statement this fake did not prepare");
        database.query(statement.sql).run(...statement.params);
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

/**
 * The schema a deployment converges to: the target description's statements,
 * in the same order `Paykit.sync` applies them. Nothing is read from disk, so a
 * test and a release cannot disagree about the DDL.
 */
const migrated = () => {
  const database = new Database(":memory:");

  for (const statement of schemaStatementsOf(BILLING_SCHEMA, { dialect: "sqlite" })) {
    database.exec(statement);
  }

  return database;
};

describe("the example on a SQL database", () => {
  it.live("serves the tenant Api from rows, not from memory", () =>
    Effect.gen(function* () {
      const database = migrated();
      const { world } = billingOnSql(d1Over(database), { now: () => 1_700_000_000_000 });

      const subscribed = yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        const receipt = yield* tenant.Subscribe(account.id, freeInput, asAccount);
        const entitlements = yield* Entitlements;
        yield* entitlements.query(account, { atLeast: receipt });

        return receipt;
      }).pipe(Effect.provide(world));

      const check = yield* Check(account.id).pipe(Effect.provide(world));
      const answer = yield* check({ featureId: messages.id, requiredBalance: 1 });
      expect(answer.allowed).toBe(true);
      expect(answer.balance.remaining).toBe(100);

      // The truth and the read model are rows in the same database.
      const event = database
        .query('SELECT COUNT(*) AS n FROM "billing_event" WHERE aggregate = ?')
        .get("Subscription") as { n: number };

      expect(event.n).toBe(1);

      const view = database
        .query('SELECT state FROM "billing_rm_view_state" WHERE view = ? AND key = ?')
        .get("Entitlements", account.id) as { state: string };

      expect(JSON.parse(view.state).features.messages.remaining).toBe(100);
      expect(subscribed.version).toBe(1);
    }),
  );

  it.live("records usage and answers the next check from the same row", () =>
    Effect.gen(function* () {
      const { world } = billingOnSql(d1Over(migrated()), { now: () => 1_700_000_000_000 });
      yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        yield* tenant.Subscribe(account.id, freeInput, asAccount);

        const tracked = yield* tenant.TrackUsage(
          account.id,
          { feature: messages.id, amount: 30 },
          asAccount,
        );

        const entitlements = yield* Entitlements;
        yield* entitlements.query(account, { atLeast: tracked });
      }).pipe(Effect.provide(world));

      const check = yield* Check(account.id).pipe(Effect.provide(world));
      expect((yield* check({ featureId: messages.id })).balance.remaining).toBe(70);
    }),
  );

  it.live("pages the read model through SQL, not through the whole table", () =>
    Effect.gen(function* () {
      const { world } = billingOnSql(d1Over(migrated()), { now: () => 1_700_000_000_000 });
      yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        const receipt = yield* tenant.Subscribe(account.id, freeInput, asAccount);
        const entitlements = yield* Entitlements;
        yield* entitlements.query(account, { atLeast: receipt });
      }).pipe(Effect.provide(world));

      const list = yield* List().pipe(Effect.provide(world));
      const page = yield* list({ take: 10 });
      expect(page.rows.map((row) => row.account)).toEqual([account.id]);
      expect(page.rows[0]?.tier).toBe("free");
      expect(page.next).toBeNull();
    }),
  );

  it.live("a guard refusal is the Api's, not the store's", () =>
    Effect.gen(function* () {
      const { world } = billingOnSql(d1Over(migrated()), { now: () => 1_700_000_000_000 });

      const refused = yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;

        return yield* Effect.exit(tenant.Subscribe(account.id, freeInput));
      }).pipe(Effect.provide(world));

      expect(refused._tag).toBe("Failure");
      expect(String(refused)).toContain("Unauthenticated");
    }),
  );

  it.live("the migration file creates every table paykit expects", () =>
    Effect.gen(function* () {
      const database = migrated();

      const names = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'billing_%'",
        )
        .all()
        .map((row) => row.name);

      expect(names).toContain("billing_event");
      expect(names).toContain("billing_receipt");
      expect(names).toContain("billing_rm_view_state");
      expect(names).toContain("billing_rm_stream_entry");
      expect(names).toContain("billing_rm_backfill");
      expect(names).toContain("billing_rm_view_outbox");
      // The catalog the example declares is one `catalog()` validates.
      const validated = yield* catalog(billingCatalog);

      expect(billingCatalog.tiers.map((tier) => tier.id)).toEqual(
        validated.tiers.map((tier) => tier.id),
      );
    }),
  );
});
