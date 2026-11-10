import { Database } from "bun:sqlite";
import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { BillingReadStore, MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, planItemsOf } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { migrate } from "../../src/Migrations/index.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import type { SqlExecutor, SqlValue } from "../../src/Store/Sql.ts";
import { SqlAggregateStore } from "../../src/Store/SqlAggregateStore.ts";
import { SqlEventLog } from "../../src/Store/SqlEventLog.ts";
import { SqlPlatform } from "../../src/Store/SqlPlatform.ts";
import { BillingRead, BillingReadLive } from "../../src/Subscription/BillingRead.projection.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier] }));
const free = planItemsOf(testCatalog, "free")!;

/**
 * The model a view backfill is measured on: one aggregate, its view, and the
 * projection that reads the view. No other consumer runs first and reads every
 * account, so the read count at the first view-state write is the backfill's
 * own.
 */
class BackfillModel extends Domain.Model("PlatformBackfill", {
  aggregates: [Subscription],
  views: [Entitlements],
  projections: [BillingRead],
}) {}

/** Five tenants with history: a backfill used to hold all five at once. */
const accounts = [
  "acct_platform_1",
  "acct_platform_2",
  "acct_platform_3",
  "acct_platform_4",
  "acct_platform_5",
] as const;

/** One activation and one usage event per account, in account order. */
const seed = Effect.gen(function* () {
  const subscription = yield* Subscription;

  for (const [index, id] of accounts.entries()) {
    const ref = Subscription.ref(id);

    yield* subscription.send(
      ref,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "free",
        allowances: free,
      }),
      { commandId: `subscribe:${id}` } as never,
    );

    yield* subscription.send(ref, new TrackUsage({ feature: "messages", amount: index + 1 }), {
      commandId: `track:${id}`,
    } as never);
  }
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

const hostedBackfill = (platform: Domain.Platform["Service"]) =>
  BackfillModel.layer(BillingReadLive.pipe(Layer.provide(MemoryBillingReadStore))).pipe(
    Layer.provideMerge(MemoryBillingReadStore),
    Layer.provideMerge(Layer.succeed(Domain.Platform, platform)),
    Layer.provideMerge(Layer.succeed(Actor, system("test"))),
  );

/** A durable log on a real SQLite database. */
const worldOver = (sql: SqlExecutor) =>
  Effect.gen(function* () {
    const clock = { now: 1_700_000_000_000 };
    yield* migrate(sql);
    const log = SqlEventLog(sql, { now: () => clock.now });

    const { platform } = SqlPlatform(sql, log, {
      now: () => clock.now,
      pollMillis: 5,
    });

    return { sql, log, clock, platform };
  });

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

const stateRows = (sql: SqlExecutor) =>
  sql.all<{ key: string; state: string; version: number | string }>(
    "SELECT key, state, version FROM billing_rm_view_state WHERE view = ? ORDER BY key",
    ["Entitlements"],
  );

/**
 * Count the accounts whose event rows a query has returned, and record that
 * count at every view-state write. A backfill that gathered every account
 * before folding one would write the first key with every account already read.
 */
const countingExecutor = (
  executor: SqlExecutor,
  read: Ref.Ref<ReadonlySet<string>>,
  writes: Ref.Ref<ReadonlyArray<number>>,
): SqlExecutor => {
  const query = executor.query;
  const write = executor.write;

  if (query === undefined || write === undefined) return executor;

  return {
    ...executor,
    query: <A>(statement: string, params?: ReadonlyArray<SqlValue>) =>
      Effect.tap(query<A>(statement, params), () =>
        Effect.gen(function* () {
          if (!statement.includes("billing_event") || !statement.includes("account = ?")) return;

          const account = params?.[1];

          if (typeof account !== "string") return;

          yield* Ref.update(read, (seen) =>
            seen.has(account) ? seen : new Set([...seen, account]),
          );
        }),
      ),
    write: (statement: string, params?: ReadonlyArray<SqlValue>) =>
      Effect.tap(write(statement, params), () =>
        Effect.gen(function* () {
          if (!statement.includes("billing_rm_view_state")) return;

          const seen = yield* Ref.get(read);

          yield* Ref.update(writes, (all) => [...all, seen.size]);
        }),
      ),
  };
};

/** The state a store commits for a stand-in aggregate's one command. */
const counterKit = {
  name: "Counter",
  handle: (input: {
    readonly id: string;
    readonly version: number;
    readonly state: unknown;
    readonly commandId: string;
  }) =>
    Effect.succeed({
      _tag: "Accepted" as const,
      state: { count: ((input.state as { readonly count: number } | null)?.count ?? 0) + 1 },
      version: input.version + 1,
      events: [
        {
          event: { _tag: "Ticked" },
          envelope: {
            id: input.id,
            seq: input.version + 1,
            at: 1,
            commandId: input.commandId,
          },
        },
      ],
      reply: {},
      deliveries: [],
    }),
  deliver: () => Effect.void,
};

const changesStore = (log: ReturnType<typeof SqlEventLog>, sql: SqlExecutor) =>
  SqlAggregateStore(log, {
    aggregate: "Counter",
    now: () => 1_700_000_000_000,
    pollMillis: 5,
    // The same cheap read `SqlPlatform` supplies: the version column alone.
    versionOf: (id: string) =>
      Effect.map(
        Effect.sync(() =>
          sql.get<{ version: number | string }>(
            "SELECT version FROM billing_state WHERE aggregate = ? AND account = ?",
            ["Counter", id],
          ),
        ),
        (row) => (row === undefined ? 0 : Number(row.version)),
      ),
  });

describe("the SQL platform", () => {
  it.live("backfills a view over many accounts into the state each key's history folds", () =>
    Effect.gen(function* () {
      const direct = yield* worldOver(sqliteExecutor(new Database(":memory:")));
      const backfilled = yield* worldOver(sqliteExecutor(new Database(":memory:")));

      yield* seed.pipe(Effect.provide(hosted(direct.platform)));
      yield* seed.pipe(Effect.provide(hosted(backfilled.platform)));

      wipeConsumers(direct.sql);
      wipeConsumers(backfilled.sql);

      const readEvery = Effect.gen(function* () {
        const entitlements = yield* Entitlements;

        for (const id of accounts) yield* entitlements.query(Subscription.ref(id));
      });

      // Entitlements is lazy here, so each key folds its own instance's
      // history directly. The other world replays the same history at start.
      yield* readEvery.pipe(Effect.provide(hosted(direct.platform, { lazy: ["Entitlements"] })));
      yield* readEvery.pipe(Effect.provide(hosted(backfilled.platform)));

      expect(stateRows(backfilled.sql)).toEqual(stateRows(direct.sql));
      expect(stateRows(backfilled.sql).length).toBe(accounts.length);
    }),
  );

  it.live("backfills a view one key at a time, so one account's history is the peak", () =>
    Effect.gen(function* () {
      const read = yield* Ref.make<ReadonlySet<string>>(new Set());
      const writes = yield* Ref.make<ReadonlyArray<number>>([]);

      const executor = countingExecutor(sqliteExecutor(new Database(":memory:")), read, writes);
      const world = yield* worldOver(executor);

      yield* seed.pipe(Effect.provide(hostedBackfill(world.platform)));

      // The view and the projection are both new to the platform.
      wipeConsumers(world.sql);
      yield* Ref.set(read, new Set());
      yield* Ref.set(writes, []);

      const rebuilt = yield* Effect.gen(function* () {
        const store = yield* BillingReadStore;

        for (const [index, id] of accounts.entries()) {
          const row = yield* store.get(id);

          expect(row?.features.messages?.used).toBe(index + 1);
        }

        return stateRows(world.sql);
      }).pipe(Effect.provide(hostedBackfill(world.platform)));

      // Every key folded its two events exactly once, and the projection saw
      // every delivery once.
      expect(rebuilt.map((row) => row.key)).toEqual([...accounts].sort());
      expect(rebuilt.map((row) => Number(row.version))).toEqual(accounts.map(() => 2));

      // The first key was written after reading only that key's events: a
      // global gather would have read all five accounts before the first write.
      expect((yield* Ref.get(writes))[0]).toBe(1);
    }),
  );

  it.live("drains past an outbox row for an aggregate this model does not host", () =>
    Effect.gen(function* () {
      const world = yield* worldOver(sqliteExecutor(new Database(":memory:")));

      yield* seed.pipe(Effect.provide(hosted(world.platform)));

      // Isolate the two rows this test is about.
      world.sql.run("UPDATE billing_outbox SET delivered_at = ? WHERE delivered_at IS NULL", [
        world.clock.now,
      ]);

      const delivery = world.sql.get<{ delivery: string }>(
        "SELECT delivery FROM billing_outbox WHERE aggregate = ? ORDER BY seq DESC LIMIT 1",
        ["Subscription"],
      )!.delivery;

      world.sql.run(
        "INSERT INTO billing_outbox (aggregate, account, event_seq, delivery) VALUES (?, ?, ?, ?)",
        [
          "Ghost",
          "acct_ghost",
          1,
          JSON.stringify({ target: { kind: "view", name: "Entitlements" }, key: "acct_ghost" }),
        ],
      );
      const ghost = world.sql.get<{ seq: number | string }>("SELECT last_insert_rowid() AS seq")!;

      world.sql.run(
        "INSERT INTO billing_outbox (aggregate, account, event_seq, delivery) VALUES (?, ?, ?, ?)",
        ["Subscription", accounts[0], 1, delivery],
      );
      const good = world.sql.get<{ seq: number | string }>("SELECT last_insert_rowid() AS seq")!;

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* (yield* Entitlements).query(Subscription.ref(accounts[0]));
        }).pipe(Effect.provide(hosted(world.platform))),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      const defect = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";
      expect(defect).toContain("Ghost");
      expect(defect).toContain("1 undelivered row");

      const delivered = (seq: number | string) =>
        world.sql.get<{ delivered_at: number | null }>(
          "SELECT delivered_at FROM billing_outbox WHERE seq = ?",
          [Number(seq)],
        )?.delivered_at;

      // The hosted row made progress; the unhosted one is still waiting and
      // named, instead of stopping the drain before it.
      expect(delivered(good.seq)).not.toBeNull();
      expect(delivered(ghost.seq)).toBeNull();
    }),
  );

  it.live("delivers a hosted row a writer adds after that aggregate's turn", () =>
    Effect.gen(function* () {
      const world = yield* worldOver(sqliteExecutor(new Database(":memory:")));

      yield* seed.pipe(Effect.provide(hosted(world.platform)));

      world.sql.run("UPDATE billing_outbox SET delivered_at = ? WHERE delivered_at IS NULL", [
        world.clock.now,
      ]);

      const delivery = world.sql.get<{ delivery: string }>(
        "SELECT delivery FROM billing_outbox WHERE aggregate = ? ORDER BY seq DESC LIMIT 1",
        ["Subscription"],
      )!.delivery;

      world.sql.run(
        "INSERT INTO billing_outbox (aggregate, account, event_seq, delivery) VALUES (?, ?, ?, ?)",
        ["Subscription", accounts[0], 1, delivery],
      );
      const first = world.sql.get<{ seq: number | string }>("SELECT last_insert_rowid() AS seq")!;

      const injected = yield* Ref.make(false);
      const injectedSeq = yield* Ref.make<number | undefined>(undefined);

      // The next unfiltered read is the drain's final check: the window in
      // which a concurrent writer commits after the hosted pass.
      const racingLog = {
        ...world.log,
        pendingDeliveries: (
          limit = 100,
          filter?: { readonly aggregate?: string; readonly account?: string },
        ) =>
          Effect.gen(function* () {
            if (filter === undefined && !(yield* Ref.get(injected))) {
              yield* Ref.set(injected, true);

              const seq = yield* Effect.sync(() => {
                world.sql.run(
                  "INSERT INTO billing_outbox (aggregate, account, event_seq, delivery) VALUES (?, ?, ?, ?)",
                  ["Subscription", accounts[0], 1, delivery],
                );

                return Number(
                  world.sql.get<{ seq: number | string }>("SELECT last_insert_rowid() AS seq")!.seq,
                );
              });

              yield* Ref.set(injectedSeq, seq);
            }

            return yield* world.log.pendingDeliveries(limit, filter);
          }),
      };

      const { platform } = SqlPlatform(world.sql, racingLog, {
        now: () => world.clock.now,
        pollMillis: 5,
      });

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* (yield* Entitlements).query(Subscription.ref(accounts[0]));
        }).pipe(Effect.provide(hosted(platform))),
      );

      expect(Exit.isSuccess(exit)).toBe(true);

      const second = yield* Ref.get(injectedSeq);

      expect(second).toBeDefined();
      expect(world.sql.all("SELECT seq FROM billing_outbox WHERE delivered_at IS NULL")).toEqual(
        [],
      );

      const delivered = (seq: number | string) =>
        world.sql.get<{ delivered_at: number | null }>(
          "SELECT delivered_at FROM billing_outbox WHERE seq = ?",
          [Number(seq)],
        )?.delivered_at;

      expect(delivered(first.seq)).not.toBeNull();

      if (second !== undefined) expect(delivered(second)).not.toBeNull();
    }),
  );

  it.live("changes emits the current state and then one state per commit", () =>
    Effect.gen(function* () {
      const database = new Database(":memory:");
      const world = yield* worldOver(sqliteExecutor(database));

      const reader = yield* changesStore(world.log, world.sql);
      const writer = yield* changesStore(world.log, world.sql);

      reader.bind(counterKit as never);
      writer.bind(counterKit as never);

      yield* writer.send(
        "acct_changes",
        { _tag: "Tick" } as never,
        { commandId: "cmd-1" } as never,
      );

      const firstSeen = yield* Deferred.make<void>();

      const collecting = yield* Effect.forkChild(
        reader.changes("acct_changes").pipe(
          Stream.tap((entry) =>
            entry.version === 1 ? Effect.asVoid(Deferred.succeed(firstSeen, void 0)) : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
        ),
      );

      yield* Deferred.await(firstSeen);

      // A second store over the same database, as another writer would be.
      yield* writer.send(
        "acct_changes",
        { _tag: "Tick" } as never,
        { commandId: "cmd-2" } as never,
      );

      const states = Array.from(yield* Fiber.join(collecting));

      expect(states.map((entry) => entry.version)).toEqual([1, 2]);
      expect(states.map((entry) => (entry.state as { readonly count: number }).count)).toEqual([
        1, 2,
      ]);
    }),
  );
});
