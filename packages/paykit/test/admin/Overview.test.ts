import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AdminReads, AdminReadsLive, type BillingOverview } from "../../src/Admin/Reads.ts";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import {
  BillingReadStore,
  type BillingReadRow,
  MemoryBillingReadStore,
} from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { sync } from "../../src/Migrations/index.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsProvider } from "../../src/Payments.ts";
import { SqlBillingReadStore } from "../../src/Store/SqlBillingReadStore.ts";
import { SqlEventLog } from "../../src/Store/SqlEventLog.ts";
import { tier } from "../../src/Tier.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000, overage: "bill" })],
});

// An annual price is divided by twelve: 24_000 a year is 2_000 a month.
const annualTier = tier({
  id: "annual",
  price: { amount: 24_000, currency: "usd", interval: "annual" },
  grants: [allowance(messages, { included: 5_000, overage: "bill" })],
});

const euroTier = tier({
  id: "euro",
  price: { amount: 9_900, currency: "eur", interval: "month" },
  grants: [allowance(messages, { included: 5_000, overage: "block" })],
});

const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, annualTier, euroTier] }),
);

const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");

const row = (id: string, overrides: Partial<BillingReadRow>): BillingReadRow => ({
  account: id,
  tier: "pro",
  status: "active",
  standing: "good",
  periodStart: at,
  periodEnd: at,
  cancelAtPeriodEnd: false,
  credits: 0,
  prepaidCredits: 0,
  dunningAttempts: 0,
  features: {},
  ...overrides,
});

/**
 * A mix that exercises every dimension the overview folds: two priced
 * currencies, an annual price, and a tier the catalog does not price.
 */
const rows: ReadonlyArray<BillingReadRow> = [
  row("acct_active_pro", {}),
  row("acct_active_euro", { tier: "euro" }),
  row("acct_trial_pro", { status: "trialing" }),
  row("acct_trial_annual", { tier: "annual", status: "trialing" }),
  row("acct_grace_pro", { status: "grace", standing: "grace" }),
  row("acct_canceled_euro", { tier: "euro", status: "canceled", standing: "blocked" }),
  row("acct_expired_pro", { status: "expired", standing: "blocked" }),
  row("acct_free", { tier: "free" }),
];

/**
 * The counts and revenue by hand, from the eight rows above: `pro` is 1_900 a
 * month, `annual` is 24_000 a year (2_000 a month), `euro` is 9_900 a month,
 * and `free` has no price so it contributes to no currency.
 */
const expected = {
  accounts: 8,
  byStatus: [
    { status: "trialing", count: 2 },
    { status: "active", count: 3 },
    { status: "grace", count: 1 },
    { status: "canceled", count: 1 },
    { status: "expired", count: 1 },
  ],
  byStanding: [
    { standing: "good", count: 5 },
    { standing: "grace", count: 1 },
    { standing: "blocked", count: 2 },
  ],
  byTier: [
    { tier: "free", count: 1 },
    { tier: "pro", count: 4 },
    { tier: "annual", count: 1 },
    { tier: "euro", count: 2 },
  ],
  revenue: [
    {
      currency: "eur",
      mrr: 9_900,
      arr: 118_800,
      trialPipeline: 0,
      atRisk: 0,
      churned: 9_900,
    },
    {
      currency: "usd",
      // active pro 1_900 + grace pro 1_900
      mrr: 3_800,
      arr: 45_600,
      // trialing pro 1_900 + trialing annual 2_000
      trialPipeline: 3_900,
      // the grace pro row, which is also part of mrr
      atRisk: 1_900,
      // the expired pro row
      churned: 1_900,
    },
  ],
};

const worldFor = (store: Layer.Layer<BillingReadStore>) =>
  AdminReadsLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(store)))
          .pipe(Layer.provide(Domain.InMemory))
          .pipe(Layer.provideMerge(store)),
        catalogLayer(testCatalog),
        Layer.succeed(Actor, system("test")),
        Layer.succeed(PaymentsProvider, {
          name: "stripe",
          capabilities: new Set(["checkout"] as const),
        }),
      ),
    ),
  );

const assertOverview = (overview: BillingOverview) => {
  expect(overview.accounts).toBe(expected.accounts);
  expect(overview.byStatus).toEqual(expected.byStatus);
  expect(overview.byStanding).toEqual(expected.byStanding);
  expect(overview.byTier).toEqual(expected.byTier);
  expect(overview.revenue).toEqual(expected.revenue);
  // A snapshot, not a live read: the console says how old the counts are.
  expect(overview.asOf).toBeDefined();
};

/** Seed the same rows, then assert the overview a store's summary produces. */
const overviewCase = Effect.gen(function* () {
  const store = yield* BillingReadStore;

  for (const entry of rows) yield* store.upsert(entry);

  const reads = yield* AdminReads;

  assertOverview(yield* reads.overview());
});

const sqlStore = Effect.gen(function* () {
  const sql = sqliteExecutor();
  yield* sync(sql);

  return SqlBillingReadStore(SqlEventLog(sql, { now: () => 1_000 }));
});

/** One active `pro` row, so every other status, standing and tier is absent. */
const sparseCase = Effect.gen(function* () {
  const store = yield* BillingReadStore;

  yield* store.upsert(row("acct_only", {}));

  const reads = yield* AdminReads;
  const overview = yield* reads.overview();

  expect(overview.byStatus).toEqual([
    { status: "trialing", count: 0 },
    { status: "active", count: 1 },
    { status: "grace", count: 0 },
    { status: "canceled", count: 0 },
    { status: "expired", count: 0 },
  ]);
  expect(overview.byStanding).toEqual([
    { standing: "good", count: 1 },
    { standing: "grace", count: 0 },
    { standing: "blocked", count: 0 },
  ]);
  expect(overview.byTier).toEqual([
    { tier: "free", count: 0 },
    { tier: "pro", count: 1 },
    { tier: "annual", count: 0 },
    { tier: "euro", count: 0 },
  ]);
});

describe("the console overview", () => {
  it.live("folds the memory store's summary", () =>
    overviewCase.pipe(Effect.provide(worldFor(MemoryBillingReadStore))),
  );

  it.live("folds the SQL store's summary", () =>
    Effect.gen(function* () {
      const store = yield* sqlStore;

      yield* overviewCase.pipe(Effect.provide(worldFor(store)));
    }),
  );

  it.live("keeps a zero row for every unused status, standing and tier", () =>
    Effect.gen(function* () {
      const store = yield* sqlStore;

      yield* sparseCase.pipe(Effect.provide(worldFor(MemoryBillingReadStore)));
      yield* sparseCase.pipe(Effect.provide(worldFor(store)));
    }),
  );

  it.live("the two stores answer the same summary cells", () =>
    Effect.gen(function* () {
      const store = yield* sqlStore;
      const fromSql = yield* BillingReadStore.pipe(Effect.provide(store));
      const fromMemory = yield* BillingReadStore.pipe(Effect.provide(MemoryBillingReadStore));

      for (const entry of rows) {
        yield* fromSql.upsert(entry);
        yield* fromMemory.upsert(entry);
      }

      const summaries = yield* fromSql.summary();

      // One cell per distinct `(tier, status, standing)` in the eight rows.
      expect(summaries.length).toBe(8);
      expect(summaries).toEqual(yield* fromMemory.summary());
    }),
  );
});
