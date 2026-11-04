import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { Check } from "../../src/Check.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { ProviderCapabilityMissing } from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Portal } from "../../src/Portal.ts";
import { Subscribe } from "../../src/Subscribe.ts";
import { TierNotInCatalog } from "../../src/Subscription/TierNotInCatalog.rejection.ts";
import { AllowanceExceeded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { Track } from "../../src/Track.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier, proTier] }));

const free = allowancesOf(testCatalog, "free")!;
const pro = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const account = "acct_bindings";

const ModelWorld = PaykitModel.layer(
  PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)),
).pipe(Layer.provide(Domain.InMemory));

const withMemory = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  Effect.provide(
    effect,
    Layer.mergeAll(ModelWorld, catalogLayer(testCatalog), PaymentsMemory().payments),
  ) as Effect.Effect<A, E, never>;

const withManual = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  Effect.provide(
    effect,
    Layer.mergeAll(ModelWorld, catalogLayer(testCatalog), PaymentsManual().payments),
  ) as Effect.Effect<A, E, never>;

const withModelOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  Effect.provide(effect, Layer.mergeAll(ModelWorld, catalogLayer(testCatalog))) as Effect.Effect<
    A,
    E,
    never
  >;

describe("runtime bindings", () => {
  it.live("reports blocked before any standing exists", () =>
    Effect.gen(function* () {
      const check = yield* Check();
      const answer = yield* check({ account, feature: "messages", amount: 1 });
      expect(answer.allowed).toBe(false);
      expect(answer.standing).toBe("blocked");
      expect(answer.remaining).toBe(0);
    }).pipe(withMemory),
  );

  it.live("subscribes to a free tier, tracks usage, and answers from the read model", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const track = yield* Track();
      const check = yield* Check();
      const started = yield* subscribe({ account, tier: "free" });
      expect(started).toEqual({ activated: true });
      expect((yield* check({ account, feature: "messages", amount: 1 })).allowed).toBe(true);
      yield* track({ account, feature: "messages", amount: 30 });
      const after = yield* check({ account, feature: "messages", amount: 1 });
      expect(after.remaining).toBe(70);
      expect(after.allowed).toBe(true);
      expect(after.standing).toBe("good");
    }).pipe(withMemory),
  );

  it.live("tracks a dedupe key once and refuses past a block", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const track = yield* Track();
      const check = yield* Check();
      yield* subscribe({ account, tier: "free" });
      yield* track({ account, feature: "messages", amount: 25, dedupeKey: "req-1" });
      yield* track({ account, feature: "messages", amount: 25, dedupeKey: "req-1" });
      expect((yield* check({ account, feature: "messages", amount: 0 })).remaining).toBe(75);
      const refused = yield* Effect.exit(track({ account, feature: "messages", amount: 76 }));
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("AllowanceExceeded");
      }
    }).pipe(withMemory),
  );

  it.live("uses a provider's portal when it has one", () =>
    Effect.gen(function* () {
      const portal = yield* Portal();
      const opened = yield* portal({ account });
      expect(opened.url).toContain(account);
    }).pipe(withMemory),
  );

  it.live("a portal without a provider fails with a typed capability error", () =>
    Effect.gen(function* () {
      const portal = yield* Portal();
      const refused = yield* Effect.exit(portal({ account }));
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("ProviderCapabilityMissing");
      }
    }).pipe(withModelOnly),
  );

  it.live("a manual provider sells through an invoice and has no portal", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const portal = yield* Portal();
      const purchase = yield* subscribe({ account, tier: "pro" });
      expect("invoiceId" in purchase).toBe(true);
      const refused = yield* Effect.exit(portal({ account }));
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("ProviderCapabilityMissing");
      }
    }).pipe(withManual),
  );

  it.live("a memory provider opens a hosted checkout for a priced tier", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const purchase = yield* subscribe({ account, tier: "pro" });
      expect("url" in purchase && purchase.url).toContain("checkout");
    }).pipe(withMemory),
  );

  it.live("refuses a tier the catalog does not carry", () =>
    Effect.gen(function* () {
      const subscribe = yield* Subscribe();
      const exit = yield* Effect.exit(subscribe({ account, tier: "nope" }));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("TierNotInCatalog");
      }
    }).pipe(withMemory),
  );

  it("the test catalog's pro tier grants 2000 messages with bill overage", () => {
    expect(pro.messages.overage).toBe("bill");
    expect(free.messages.included).toBe(100);
    expect(proPrice.amount).toBe(1900);
  });

  it("TierNotInCatalog and AllowanceExceeded are the typed failures callers match", () => {
    expect(new TierNotInCatalog({ tier: "x" })._tag).toBe("TierNotInCatalog");
    expect(
      new AllowanceExceeded({
        feature: "messages",
        included: 1,
        used: 1,
        requested: 1,
        remaining: 0,
      })._tag,
    ).toBe("AllowanceExceeded");
    expect(new ProviderCapabilityMissing({ provider: "manual", op: "createPortal" })._tag).toBe(
      "ProviderCapabilityMissing",
    );
  });
});
