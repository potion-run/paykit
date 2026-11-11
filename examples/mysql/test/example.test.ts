import * as SQL from "@alchemy.run/sql/MySQL";
import { describe, expect, it } from "@alchemy.run/test";
import { asyncOf, mysqlExecutor, Paykit, Subscription, sync } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { free, messages } from "../src/catalog.ts";
import { billingOnMysql } from "../src/SqlBilling.ts";

/**
 * The live case is gated on a real MySQL, the way every vendor case in this
 * repo is: without `MYSQL_URL` it is skipped, so CI stays green with no server.
 * Point it at a scratch database — the case drops every `billing_*` table:
 *
 * ```sh
 * MYSQL_URL=mysql://user:pass@host:3306/paykit_test \
 *   pnpm --filter @potion.run/example-mysql test
 * ```
 *
 * `process.env` at module scope is the one place the Effect rule does not
 * reach: a skip gate runs before any Effect exists.
 */
const url = process.env.MYSQL_URL;
const hasUrl = url !== undefined && url !== "";

const account = Subscription.ref("acct_mysql_example");

describe("the MySQL example", () => {
  it.live.skipIf(!hasUrl)("serves the model from MySQL tables", () =>
    Effect.gen(function* () {
      if (url === undefined) return;

      const client = yield* SQL.MySQL({ url: Redacted.make(url) });
      const sql = mysqlExecutor(client);
      const port = asyncOf(sql);

      // A scratch database: drop the tables the previous run left, so the case
      // starts from the shipped files.
      const existing = yield* port.query<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.tables " +
          "WHERE table_schema = DATABASE() AND table_name LIKE 'billing\\_%'",
      );

      for (const table of existing) {
        yield* port.query(`DROP TABLE IF EXISTS \`${String(table.name)}\``);
      }

      const migrated = yield* sync(sql);
      expect(migrated.applied).toEqual(["0001_init"]);
      expect(migrated.created).toEqual([]);

      const { world } = billingOnMysql(sql, { now: () => 1_700_000_000_000 });

      yield* Effect.gen(function* () {
        const subscribe = yield* Paykit.Subscribe(account.id);
        expect(yield* subscribe({ tier: free.id })).toEqual({ activated: true });

        const track = yield* Paykit.TrackUsage(account.id);
        yield* track({ featureId: messages.id, value: 5, idempotencyKey: "req_1" });

        const check = yield* Paykit.Check(account.id);
        const answer = yield* check({ featureId: messages.id, requiredBalance: 1 });

        expect(answer.allowed).toBe(true);
        expect(answer.balance.remaining).toBe(95);
      }).pipe(Effect.provide(world));

      // The truth and the read model are rows in the same database: the
      // activation and the usage it recorded, in sequence.
      const events = yield* port.query<{ event: string }>(
        "SELECT event FROM `billing_event` WHERE aggregate = ? ORDER BY seq",
        ["Subscription"],
      );

      expect(events.map((row) => (JSON.parse(row.event) as { _tag: string })._tag)).toEqual([
        "SubscriptionActivated",
        "UsageRecorded",
      ]);

      // A second sync is a no-op over the same schema.
      expect((yield* sync(sql)).applied).toEqual([]);
    }),
  );
});
