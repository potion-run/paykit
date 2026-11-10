import { describe, expect, it } from "@alchemy.run/test";
import { asyncOf, Paykit, Subscription, sync } from "@potion.run/paykit";
import { Drizzle } from "@potion.run/paykit/Database/Drizzle";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import { free, messages } from "../src/catalog.ts";
import { openDrizzle } from "../src/Drizzle.ts";
import { billingOnPostgres } from "../src/SqlBilling.ts";

/**
 * The live case is gated on a real Postgres: without `POSTGRES_URL` it is
 * skipped, so CI stays green with no database. It drops and recreates the
 * `billing` schema.
 */
const url = process.env.POSTGRES_URL;
const hasUrl = url !== undefined && url !== "";

const account = Subscription.ref("acct_drizzle_example");

describe("the Drizzle example", () => {
  it.live.skipIf(!hasUrl)("migrates and serves the model on the pool Drizzle holds", () => {
    if (url === undefined) return Effect.void;

    const { pool, db } = openDrizzle(url);

    return Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Paykit.Database;
        const sql = yield* database.runtime;
        const port = asyncOf(sql);

        // A scratch database, so the case starts from the shipped files.
        yield* port.query('DROP SCHEMA IF EXISTS "billing" CASCADE');
        yield* port.query('CREATE SCHEMA IF NOT EXISTS "billing"');

        const migrated = yield* sync(sql, { schema: "billing" });
        expect(migrated.applied).toEqual(["0001_init"]);
        expect(migrated.created).toEqual([]);

        const { world } = billingOnPostgres(sql);

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

        // The event log is a row in the pool Drizzle opened.
        const events = yield* port.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM "billing"."billing_event" WHERE aggregate = ?',
          ["Subscription"],
        );

        expect(Number(events[0]?.n)).toBe(1);
      }),
    ).pipe(
      Effect.provide(Drizzle(db, { schema: "billing" })),
      Effect.provide(RuntimeContext.phantom),
      Effect.ensuring(Effect.promise(() => pool.end())),
    );
  });
});
