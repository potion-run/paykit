import * as SQL from "@alchemy.run/sql/Postgres";
import { describe, expect, it } from "@alchemy.run/test";
import { asyncOf, Paykit, postgresExecutor, sync, Subscription } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { free, messages } from "../src/catalog.ts";
import { billingOnPostgres } from "../src/SqlBilling.ts";

/**
 * The integration case is gated on a real Postgres, the way every vendor case
 * in this repo is: without `POSTGRES_URL` it is skipped, so CI stays green with
 * no database. Point it at a scratch database — the case drops and recreates
 * the `billing` schema:
 *
 * ```sh
 * POSTGRES_URL=postgres://user:pass@host:5432/paykit_test \
 *   pnpm --filter @potion.run/example-postgres test
 * ```
 *
 * `process.env` at module scope is the one place the Effect rule does not
 * reach: a skip gate runs before any Effect exists.
 */
const url = process.env.POSTGRES_URL;
const hasUrl = url !== undefined && url !== "";

const account = Subscription.ref("acct_postgres_example");

describe("the Postgres example", () => {
  it.live.skipIf(!hasUrl)("serves the model from Postgres tables", () =>
    Effect.gen(function* () {
      if (url === undefined) return;

      // The same client the Worker uses: Alchemy's `@effect/sql-pg` client,
      // built from a connection string. Hyperdrive supplies that string in the
      // Worker; a test supplies it directly.
      const client = yield* SQL.Postgres({ url: Redacted.make(url) });
      const sql = asyncOf(postgresExecutor(client));

      // A scratch database. `sync` is what the deploy Action runs: apply the
      // shipped files through Alchemy's registry, then converge the shipped
      // description against what the database actually has.
      yield* sql.query('DROP SCHEMA IF EXISTS "billing" CASCADE');
      yield* sql.query('CREATE SCHEMA IF NOT EXISTS "billing"');

      const migrated = yield* sync(postgresExecutor(client), { schema: "billing" });
      expect(migrated.applied).toEqual(["0001_init"]);
      expect(migrated.created).toEqual([]);
      expect(migrated.columns).toEqual([]);

      const { world } = billingOnPostgres(postgresExecutor(client));

      yield* Effect.gen(function* () {
        const subscribe = yield* Paykit.Subscribe(account.id);
        expect(yield* subscribe({ tier: free.id })).toEqual({ activated: true });

        const track = yield* Paykit.TrackUsage(account.id);
        yield* track({ featureId: messages.id, value: 5, idempotencyKey: "req_1" });

        const check = yield* Paykit.Check(account.id);
        const answer = yield* check({ featureId: messages.id, requiredBalance: 1 });

        expect(answer.allowed).toBe(true);
        expect(answer.balance.remaining).toBe(95);

        // The read model is a row in the same schema, not process memory.
        const stored = yield* sql.get<{ state: string }>(
          `SELECT state FROM "billing"."billing_rm_view_state" WHERE view = ? AND key = ?`,
          ["Entitlements", account.id],
        );

        if (stored === undefined) return yield* Effect.die("the Entitlements row is missing");

        expect(JSON.parse(stored.state).features.messages.remaining).toBe(95);
      }).pipe(Effect.provide(world));
    }),
  );
});
