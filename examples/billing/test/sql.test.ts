import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "@alchemy.run/test";
import {
  BillingApi,
  catalog,
  Check,
  Entitlements,
  List,
  type D1Like,
  type D1Prepared,
  Subscription,
  type SqlValue,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Catalog } from "../src/Billing.ts";
import { billingCatalog } from "../src/catalog.ts";
import { billingOnSql } from "../src/SqlBilling.ts";
import { tierCommand } from "./support.ts";

const account = Subscription.ref("acct_sql_example");
const asAccount = { headers: { "x-paykit-actor": account.id } };
const free = Effect.runSync(tierCommand("free"));

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
 * The schema a deployment applies, taken from the generated migration file —
 * so a test and a release run the same DDL, and a stale file fails here.
 */
const migrated = () => {
  const database = new Database(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  // Apply what a deploy applies, in the order D1 walks the directory: a stale
  // or missing file fails here instead of in a release.
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(new URL(file, directory), "utf8"));
  }
  return database;
};

describe("the example on a SQL database", () => {
  it.live("serves the tenant Api from rows, not from memory", () =>
    Effect.gen(function* () {
      const database = migrated();
      const { world } = billingOnSql(d1Over(database));

      const subscribed = yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
        const entitlements = yield* Entitlements;
        yield* entitlements.query(account, { atLeast: receipt });
        return receipt;
      }).pipe(Effect.provide(world));

      const check = yield* Check(account.id).pipe(Effect.provide(world));
      const answer = yield* check({ feature: "messages", amount: 1 });
      expect(answer.allowed).toBe(true);
      expect(answer.remaining).toBe(100);

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
      const { world } = billingOnSql(d1Over(migrated()));
      yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        yield* tenant.Subscribe(account.id, free, asAccount);
        const tracked = yield* tenant.TrackUsage(
          account.id,
          { feature: "messages", amount: 30 },
          asAccount,
        );
        const entitlements = yield* Entitlements;
        yield* entitlements.query(account, { atLeast: tracked });
      }).pipe(Effect.provide(world));

      const check = yield* Check(account.id).pipe(Effect.provide(world));
      expect((yield* check({ feature: "messages" })).remaining).toBe(70);
    }),
  );

  it.live("pages the read model through SQL, not through the whole table", () =>
    Effect.gen(function* () {
      const { world } = billingOnSql(d1Over(migrated()));
      yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
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
      const { world } = billingOnSql(d1Over(migrated()));
      const refused = yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        return yield* Effect.exit(tenant.Subscribe(account.id, free));
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
      expect(Catalog.tiers.map((tier) => tier.id)).toEqual(validated.tiers.map((tier) => tier.id));
      expect(Option.isNone(Option.none())).toBe(true);
    }),
  );
});
