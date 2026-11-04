import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@alchemy.run/test";
import {
  BillingApi,
  catalog,
  Check,
  Entitlements,
  List,
  type D1Like,
  Subscription,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Catalog } from "../src/Billing.ts";
import { tierCommand } from "../src/Billing.ts";
import { billingCatalog } from "../src/catalog.ts";
import { billingOnSql } from "../src/SqlBilling.ts";

const account = Subscription.ref("acct_sql_example");
const asAccount = { headers: { "x-paykit-actor": account.id } };
const free = tierCommand("free");

/**
 * A `D1Like` over a real SQLite database: the same shape a Worker's binding
 * has, so the wiring the Worker uses is what this test exercises.
 */
const d1Over = (database: Database): D1Like => ({
  prepare: (sql: string) => {
    const make = (params: ReadonlyArray<never>) => ({
      sql,
      params,
      all: async () => ({ results: database.query(sql).all(...params) }),
    });
    return {
      ...make([]),
      bind: (...params: ReadonlyArray<never>) => make(params),
    } as ReturnType<D1Like["prepare"]>;
  },
  batch: async (statements) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        const { sql, params } = statement as unknown as {
          readonly sql: string;
          readonly params: ReadonlyArray<never>;
        };
        database.query(sql).run(...params);
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
  database.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
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

      const check = yield* Check().pipe(Effect.provide(world));
      const answer = yield* check({ account: account.id, feature: "messages", amount: 1 });
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

      const check = yield* Check().pipe(Effect.provide(world));
      expect((yield* check({ account: account.id, feature: "messages" })).remaining).toBe(70);
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
      const names = (
        database
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'billing_%'")
          .all() as ReadonlyArray<{ name: string }>
      ).map((row) => row.name);
      expect(names).toContain("billing_event");
      expect(names).toContain("billing_receipt");
      expect(names).toContain("billing_rm_view_state");
      expect(names).toContain("billing_rm_stream_entry");
      // The catalog the example declares is one `catalog()` validates.
      const validated = yield* catalog(billingCatalog);
      expect(Catalog.tiers.map((tier) => tier.id)).toEqual(validated.tiers.map((tier) => tier.id));
      expect(Option.isNone(Option.none())).toBe(true);
    }),
  );
});
