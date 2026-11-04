import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AdminReads, AdminReadsLive } from "../../src/Admin/Reads.ts";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import {
  BillingReadStore,
  type BillingReadRow,
  MemoryBillingReadStore,
} from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsProvider } from "../../src/Payments.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000, overage: "bill" })],
});
const scaleTier = tier({
  id: "scale",
  price: { amount: 9900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 5000, overage: "block" })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, scaleTier] }),
);
const proAllowances = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const account = "acct_admin_reads";

const ModelWorld = PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(Layer.provideMerge(MemoryBillingReadStore));

const Base = Layer.mergeAll(
  ModelWorld,
  catalogLayer(testCatalog),
  Layer.succeed(Actor, system("test")),
  Layer.succeed(PaymentsProvider, {
    name: "stripe",
    capabilities: new Set(["checkout"] as const),
  }),
);

const World = AdminReadsLive.pipe(Layer.provideMerge(Base));

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");

const row = (id: string, overrides: Partial<BillingReadRow> = {}): BillingReadRow => ({
  account: id,
  tier: "pro",
  status: "active",
  standing: "good",
  periodStart: at,
  periodEnd: at,
  cancelAtPeriodEnd: false,
  credits: 0,
  dunningAttempts: 0,
  features: {},
  ...overrides,
});

const subscribeToPro = Effect.gen(function* () {
  const subscription = yield* Subscription;
  yield* subscription.send(
    Subscription.ref(account),
    new Subscribe({ tier: "pro", allowances: proAllowances, price: proPrice }),
  );
});

describe("the admin read port", () => {
  it.live("pages the cross-account projection", () =>
    Effect.gen(function* () {
      const store = yield* BillingReadStore;
      yield* store.upsert(row("acct_b"));
      yield* store.upsert(row("acct_a"));
      const reads = yield* AdminReads;
      const page = yield* reads.list({ take: 1 });
      expect(page.rows.map((entry) => entry.account)).toEqual(["acct_a"]);
      expect(page.next).toBe("acct_a");
    }).pipe(run),
  );

  it.live("returns an accepted preview as wire data", () =>
    Effect.gen(function* () {
      yield* subscribeToPro;
      const reads = yield* AdminReads;
      const answer = yield* reads.preview({
        account,
        command: { kind: "changeTier", tier: "scale" },
      });
      expect(answer._tag).toBe("accepted");
      if (answer._tag !== "accepted") return;
      expect(answer.events.map((event) => event._tag)).toEqual(["TierChanged"]);
      expect(answer.proration?.due).toBe(8000);
    }).pipe(run),
  );

  it.live("returns a rejection as data, not a transport failure", () =>
    Effect.gen(function* () {
      const reads = yield* AdminReads;
      const answer = yield* reads.preview({
        account,
        command: { kind: "changeTier", tier: "scale" },
      });
      expect(answer._tag).toBe("rejected");
      if (answer._tag !== "rejected") return;
      expect(answer.rejection._tag).toBe("NotSubscribed");
    }).pipe(run),
  );

  it.live("turns a tier the catalog lacks into a typed rejection", () =>
    Effect.gen(function* () {
      const reads = yield* AdminReads;
      const answer = yield* reads.preview({
        account,
        command: { kind: "subscribe", tier: "enterprise" },
      });
      expect(answer._tag).toBe("rejected");
      if (answer._tag !== "rejected") return;
      expect(answer.rejection._tag).toBe("TierNotInCatalog");
    }).pipe(run),
  );

  it.live("verifies an account against the deploy's catalog and provider", () =>
    Effect.gen(function* () {
      yield* subscribeToPro;
      const reads = yield* AdminReads;
      const mismatches = yield* reads.verify({ account });
      expect(mismatches.map((mismatch) => mismatch._tag)).toEqual(["MissingProviderRef"]);
    }).pipe(run),
  );

  it.live("serves the catalog the deployment validated", () =>
    Effect.gen(function* () {
      const reads = yield* AdminReads;
      const served = yield* reads.catalog();
      expect(served.tiers.map((entry) => entry.id)).toEqual(["free", "pro", "scale"]);
    }).pipe(run),
  );
});
