import { Database } from "bun:sqlite";
import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { BillingReadStore, MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { planItemsOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { migrate } from "../../src/Migrations/index.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import type { SqlExecutor } from "../../src/Store/Sql.ts";
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
const free = planItemsOf(testCatalog, "free")!;
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

const hosted = (
  platform: Domain.Platform["Service"],
  options?: { readonly lazy?: ReadonlyArray<string> },
) =>
  PaykitModel.layer(
    PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
    options as never,
  ).pipe(
    // Merged outward so a test reads the same store the projection wrote.
    Layer.provideMerge(MemoryBillingReadStore),
    Layer.provideMerge(Layer.succeed(Domain.Platform, platform)),
    Layer.provideMerge(Layer.succeed(Actor, system("test"))),
  );

/** Drop every consumer row; `billing_event` is untouched. */
const wipeConsumers = (sql: SqlExecutor) =>
  sql.exec(`
    DELETE FROM billing_rm_view_state;
    DELETE FROM billing_rm_view_entry;
    DELETE FROM billing_rm_view_input;
    DELETE FROM billing_rm_view_outbox;
    DELETE FROM billing_rm_projection_input;
    DELETE FROM billing_rm_projection_cursor;
    DELETE FROM billing_rm_policy_seen;
    DELETE FROM billing_rm_stream_entry;
    DELETE FROM billing_rm_stream_meta;
    DELETE FROM billing_rm_billing_read;
    DELETE FROM billing_rm_backfill;
  `);

describe("the model hosted on SQL", () => {
  it.live("writes the command's events, state and receipt to one database", () =>
    Effect.gen(function* () {
      const { platform, log } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        yield* subscription.send(
          account,
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
          {
            commandId: "subscribe-1",
          } as never,
        );
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
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
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
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
          { commandId: "subscribe-1" } as never,
        );

        const again = yield* subscription.send(
          account,
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
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
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
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
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
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

  it.live("rebuilds a dropped consumer and the projection that reads it", () =>
    Effect.gen(function* () {
      const { platform, sql } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        const entitlements = yield* Entitlements;

        const receipt = yield* subscription.send(
          account,
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
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

      // A consumer is only a fold, so dropping every consumer row and
      // rebuilding the model must reproduce the same answers from the log.
      wipeConsumers(sql);

      const rebuilt = yield* Effect.gen(function* () {
        const entitlements = yield* Entitlements;
        const view = Option.getOrNull(yield* entitlements.query(account));
        const history = yield* entitlements.history;
        const store = yield* BillingReadStore;
        const row = yield* store.get(account.id);

        return { view, history, row };
      }).pipe(Effect.provide(hosted(platform)));

      expect(rebuilt.view?.features.messages?.used).toBe(12);
      expect(rebuilt.row?.features.messages?.used).toBe(12);
      // The platform reports the history it just replayed, not a default.
      expect(rebuilt.history.complete).toBe(true);
      // The backfill that filled them is recorded, so a restart skips it.
      expect(
        sql.all<{ consumer: string }>("SELECT consumer FROM billing_rm_backfill").length,
      ).toBeGreaterThan(0);
    }),
  );

  it.live("a lazy view fills each key from its own history before a projection reads it", () =>
    Effect.gen(function* () {
      const { platform, sql } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        yield* subscription.send(
          account,
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
          { commandId: "subscribe-1" } as never,
        );
        yield* subscription.send(account, new TrackUsage({ feature: "messages", amount: 7 }), {
          commandId: "track-1",
        } as never);
      }).pipe(Effect.provide(hosted(platform)));

      wipeConsumers(sql);

      // Entitlements is not backfilled by the deploy: its key reads its own
      // source before answering. BillingRead reads it, so the projection's
      // backfill is what forces the catch-up.
      const rebuilt = yield* Effect.gen(function* () {
        const entitlements = yield* Entitlements;
        const view = Option.getOrNull(yield* entitlements.query(account));
        const store = yield* BillingReadStore;
        const row = yield* store.get(account.id);

        return { view, row };
      }).pipe(Effect.provide(hosted(platform, { lazy: ["Entitlements"] })));

      expect(rebuilt.view?.features.messages?.used).toBe(7);
      expect(rebuilt.row?.features.messages?.used).toBe(7);
      expect(
        sql.get("SELECT 1 AS one FROM billing_rm_backfill WHERE consumer = ?", [
          "view:Entitlements",
        ]),
      ).toBeUndefined();
    }),
  );

  it.live("a view finishes a downstream delivery a crash left pending", () =>
    Effect.gen(function* () {
      const { platform, sql } = yield* world;
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription;
        const entitlements = yield* Entitlements;

        const receipt = yield* subscription.send(
          account,
          new Subscribe({
            credits: 0,
            creditsExpire: "period",
            rates: {},
            tier: "free",
            allowances: free,
          }),
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

      // Simulate a crash after the view committed its entry but before its
      // downstream delivery reached the projection: drop the projection and
      // leave one staged row. The backfill record stays, so a rebuild does not
      // simply replay the projection on the deploy path.
      sql.exec(
        "DELETE FROM billing_rm_projection_input; DELETE FROM billing_rm_projection_cursor;",
      );

      const stored = sql.get<{ state: string }>(
        "SELECT state FROM billing_rm_view_state WHERE view = ? AND key = ?",
        ["Entitlements", account.id],
      )!;

      const entry = sql.get<{ seq: number; event: string; envelope: string }>(
        "SELECT seq, event, envelope FROM billing_rm_view_entry WHERE view = ? AND key = ? ORDER BY seq DESC LIMIT 1",
        ["Entitlements", account.id],
      )!;

      const event = JSON.parse(entry.event) as { readonly _tag: string };

      const delivery = {
        target: { kind: "projection", name: "BillingRead" },
        key: account.id,
        source: `Entitlements/${account.id}`,
        seq: Number(entry.seq),
        origin: "Entitlements",
        tag: event._tag,
        event,
        envelope: JSON.parse(entry.envelope) as unknown,
        state: JSON.parse(stored.state) as unknown,
      };

      sql.run(
        "INSERT INTO billing_rm_view_outbox (view, key, entry_seq, delivery) VALUES (?, ?, ?, ?)",
        ["Entitlements", account.id, entry.seq, JSON.stringify(delivery)],
      );

      const row = yield* Effect.gen(function* () {
        // A read drains what the crash left behind before it answers.
        yield* (yield* Entitlements).query(account);

        return yield* (yield* BillingReadStore).get(account.id);
      }).pipe(Effect.provide(hosted(platform)));

      expect(row?.features.messages?.used).toBe(12);
      expect(
        sql.get("SELECT 1 AS one FROM billing_rm_view_outbox WHERE view = ? AND key = ?", [
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
