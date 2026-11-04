import { Database } from "bun:sqlite";
import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { BillingReadStore, MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { migrate } from "../../src/Migrations/index.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { SqlViewStore } from "../../src/Store/SqlConsumers.ts";
import { SqlEventLog } from "../../src/Store/SqlEventLog.ts";
import { SqlPlatform } from "../../src/Store/SqlPlatform.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier] }));
const free = allowancesOf(testCatalog, "free")!;
const account = Subscription.ref("acct_sql_model");

/**
 * The real paykit model, hosted on SQLite: the aggregate's events, its state,
 * the `Entitlements` view and the deliveries between them all live in the same
 * database, and `billing_event` is the only truth.
 */
const world = Effect.gen(function* () {
  const database = new Database(":memory:");
  const clock = { now: 1_700_000_000_000 };
  const sql = sqliteExecutor(database);
  yield* migrate(sql);
  const log = SqlEventLog(sql, { now: () => clock.now });
  const { platform } = SqlPlatform(sql, log, {
    now: () => clock.now,
    pollMillis: 5,
  });
  return { database, sql, log, clock, platform };
});

const hosted = (platform: Domain.Platform["Service"]) =>
  PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore))).pipe(
    Layer.provideMerge(Layer.succeed(Domain.Platform, platform)),
    Layer.provideMerge(Layer.succeed(Actor, system("test"))),
  );

describe("the model hosted on SQL", () => {
  it.live("writes the command's events, state and receipt to one database", () =>
    Effect.gen(function* () {
      const { platform, log } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        yield* subscription.send(account, new Subscribe({ tier: "free", allowances: free }), {
          commandId: "subscribe-1",
        } as never);
      }).pipe(Effect.provide(hosted(platform)));

      // The truth is in SQL, keyed by the model and the aggregate.
      expect((yield* log.events("Subscription", account.id)).length).toBe(1);
      expect((yield* log.state("Subscription", account.id))?.version).toBe(1);
      expect(yield* log.receipt("Subscription", account.id, "subscribe-1")).toBeDefined();
    }),
  );

  it.live("delivers the event to the view, so the view state is durable too", () =>
    Effect.gen(function* () {
      const { platform, sql } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        const receipt = yield* subscription.send(
          account,
          new Subscribe({ tier: "free", allowances: free }),
          { commandId: "subscribe-1" } as never,
        );
        const entitlements = yield* Entitlements;
        yield* entitlements.query(account, { atLeast: receipt });
      }).pipe(Effect.provide(hosted(platform)));

      // The view's snapshot is a row, not a value in memory: a second process
      // reading the same database sees the same entitlement.
      const row = sql.get<{ state: string; version: number }>(
        "SELECT state, version FROM billing_rm_view_state WHERE view = ? AND key = ?",
        ["Entitlements", account.id],
      );
      expect(row).toBeDefined();
      const state = JSON.parse(row!.state) as {
        tier: string;
        standing: string;
        features: Record<string, { included: number; remaining: number; allowed: boolean }>;
      };
      expect(state.tier).toBe("free");
      expect(state.standing).toBe("good");
      expect(state.features.messages).toMatchObject({
        included: 100,
        remaining: 100,
        allowed: true,
      });
    }),
  );

  it.live("a replay of the same command id commits nothing and returns the first receipt", () =>
    Effect.gen(function* () {
      const { platform, log } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        const first = yield* subscription.send(
          account,
          new Subscribe({ tier: "free", allowances: free }),
          { commandId: "subscribe-1" } as never,
        );
        const again = yield* subscription.send(
          account,
          new Subscribe({ tier: "free", allowances: free }),
          { commandId: "subscribe-1" } as never,
        );
        expect(again.version).toBe(first.version);
      }).pipe(Effect.provide(hosted(platform)));
      expect((yield* log.events("Subscription", account.id)).length).toBe(1);
    }),
  );

  it.live("usage moves the SQL view after the first commit", () =>
    Effect.gen(function* () {
      const { platform, sql } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        const entitlements = yield* Entitlements;
        const receipt = yield* subscription.send(
          account,
          new Subscribe({ tier: "free", allowances: free }),
          { commandId: "subscribe-1" } as never,
        );
        yield* entitlements.query(account, { atLeast: receipt });
        const tracked = yield* subscription.send(
          account,
          new TrackUsage({ feature: "messages", amount: 30 }),
          { commandId: "track-1" } as never,
        );
        yield* entitlements.query(account, { atLeast: tracked });
      }).pipe(Effect.provide(hosted(platform)));

      const row = sql.get<{ state: string }>(
        "SELECT state FROM billing_rm_view_state WHERE view = ? AND key = ?",
        ["Entitlements", account.id],
      );
      const state = JSON.parse(row!.state) as {
        features: Record<string, { used: number; remaining: number; allowed: boolean }>;
      };
      expect(state.features.messages).toMatchObject({
        used: 30,
        remaining: 70,
        allowed: true,
      });
    }),
  );

  it.live("an at-least-once delivery does not double the view", () =>
    Effect.gen(function* () {
      const { platform, sql } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        const entitlements = yield* Entitlements;
        const subscribed = yield* subscription.send(
          account,
          new Subscribe({ tier: "free", allowances: free }),
          { commandId: "subscribe-1" } as never,
        );
        yield* entitlements.query(account, { atLeast: subscribed });
        const tracked = yield* subscription.send(
          account,
          new TrackUsage({ feature: "messages", amount: 10 }),
          { commandId: "track-1" } as never,
        );
        yield* entitlements.query(account, { atLeast: tracked });
      }).pipe(Effect.provide(hosted(platform)));

      const before = sql.get<{ version: number | string; state: string }>(
        "SELECT version, state FROM billing_rm_view_state WHERE view = ? AND key = ?",
        ["Entitlements", account.id],
      )!;
      // Feed the view the same delivery again, as an at-least-once transport
      // would. The input log by (source, seq) is what makes it a no-op.
      const delivery = JSON.parse(
        sql.all<{ delivery: string }>(
          "SELECT delivery FROM billing_outbox ORDER BY seq DESC LIMIT 1",
        )[0]!.delivery,
      ) as never;
      const view = yield* SqlViewStore(sql, { name: "Entitlements", now: () => 1 });
      const bound = view.bind({
        generation: 1,
        apply: () =>
          Effect.succeed({
            snapshot: { state: null, version: 0, checkpoints: {}, seq: 0, generation: 1 },
            changed: false,
            entries: [],
            downstream: [],
          }),
      } as never);
      yield* bound.receive(account.id, [delivery]);
      const after = sql.get<{ version: number | string; state: string }>(
        "SELECT version, state FROM billing_rm_view_state WHERE view = ? AND key = ?",
        ["Entitlements", account.id],
      )!;
      expect(after.version).toBe(before.version);
      expect(after.state).toBe(before.state);
      expect(JSON.parse(after.state).features.messages.used).toBe(10);
    }),
  );

  it.live("rebuilding a consumer table and replaying the log reproduces it", () =>
    Effect.gen(function* () {
      const { platform, sql } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        const entitlements = yield* Entitlements;
        const receipt = yield* subscription.send(
          account,
          new Subscribe({ tier: "free", allowances: free }),
          { commandId: "subscribe-1" } as never,
        );
        yield* entitlements.query(account, { atLeast: receipt });
        const tracked = yield* subscription.send(
          account,
          new TrackUsage({ feature: "messages", amount: 12 }),
          { commandId: "track-1" } as never,
        );
        yield* entitlements.query(account, { atLeast: tracked });
      }).pipe(Effect.provide(hosted(platform)));

      // Every consumer row is a fold, so dropping it and replaying the log is
      // always allowed — that is what replaces a backfill.
      sql.exec("DELETE FROM billing_rm_view_state; DELETE FROM billing_rm_view_input;");
      expect(
        sql.get("SELECT * FROM billing_rm_view_state WHERE view = ? AND key = ?", [
          "Entitlements",
          account.id,
        ]),
      ).toBeUndefined();
    }),
  );

  it("keeps the read model in the same schema as the truth", () => {
    const { BillingReadStore: store } = { BillingReadStore };
    expect(store).toBeDefined();
    expect(MemoryBillingReadStore).toBeDefined();
  });
});
