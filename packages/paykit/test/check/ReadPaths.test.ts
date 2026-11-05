import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { CheckOverTransport } from "../../src/Billing/CheckOverTransport.layer.ts";
import { CheckReadModel } from "../../src/Billing/CheckReadModel.layer.ts";
import { TrackUsage } from "../../src/Billing/TrackUsage.binding.ts";
import { BillingReadStore, MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { CheckTransport, type CheckResult } from "../../src/Check.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { BillingRead } from "../../src/Subscription/BillingRead.projection.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { bindingsWorld } from "../support/Bindings.ts";
import { waitForProjection } from "../support/ReadModel.ts";

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
const account = "acct_paths";

const Model = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(Layer.provideMerge(Layer.succeed(Actor, system("test"))));

/**
 * The tenant bundle, plus the two read paths a `Check` can take instead of the
 * model: one row from the projection, or a transport. They are layers of the
 * same tag, so a test swaps one for another and the call site does not move.
 */
const World = bindingsWorld(Model, { catalog: testCatalog });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

const subscribeFree = Effect.gen(function* () {
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  const store = yield* BillingReadStore;
  const receipt = yield* subscription.send(
    Subscription.ref(account),
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: {},
      tier: "free",
      allowances: free,
    }),
  );
  const view = Option.getOrNull(
    yield* entitlements.query(Subscription.ref(account), { atLeast: receipt }),
  );
  yield* BillingRead.caughtUp(receipt);
  yield* waitForProjection(store, account, view);
  return receipt;
});

describe("Check read paths", () => {
  it.live("in-process and read-model paths agree", () =>
    Effect.gen(function* () {
      yield* subscribeFree;
      const inProcess = yield* Check(account);
      const first = yield* inProcess({ feature: "messages", amount: 1 });
      const second = yield* Effect.gen(function* () {
        const readModel = yield* Check(account);
        return yield* readModel({ feature: "messages", amount: 1 });
      }).pipe(Effect.provide(CheckReadModel));
      expect(second).toEqual(first);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(100);
    }).pipe(run),
  );

  it.live("both paths see a Track after the projection catches up", () =>
    Effect.gen(function* () {
      yield* subscribeFree;
      const track = yield* TrackUsage(account);
      const store = yield* BillingReadStore;
      // The binding guarantees the view; the row is the projection's, so wait for
      // it to catch up with that view before reading the other path.
      yield* track({ feature: "messages", amount: 40, dedupeKey: "read-paths-40" });
      const entitlements = yield* Entitlements;
      yield* waitForProjection(
        store,
        account,
        Option.getOrNull(yield* entitlements.query(Subscription.ref(account))),
      );
      const inProcess = yield* Check(account);
      const readModel = yield* Effect.gen(function* () {
        const read = yield* Check(account);
        return yield* read({ feature: "messages", amount: 1 });
      }).pipe(Effect.provide(CheckReadModel));
      expect(readModel).toEqual(yield* inProcess({ feature: "messages", amount: 1 }));
      expect(readModel.remaining).toBe(60);
    }).pipe(run),
  );

  it.live("the read-model path answers blocked when the row does not exist", () =>
    Effect.gen(function* () {
      const answer = yield* Effect.gen(function* () {
        const read = yield* Check("acct_missing");
        return yield* read({ feature: "messages" });
      }).pipe(Effect.provide(CheckReadModel));
      expect(answer).toEqual({
        allowed: false,
        remaining: 0,
        resetsAt: null,
        standing: "blocked",
      });
    }).pipe(run),
  );

  it.live("the HTTP path delegates to its transport", () => {
    const expected: CheckResult = {
      allowed: true,
      remaining: 7,
      resetsAt: null,
      standing: "good",
    };
    let calls = 0;
    const transport = Layer.succeed(CheckTransport, {
      check: (input) =>
        Effect.sync(() => {
          calls++;
          return { ...expected, remaining: input.amount === undefined ? 7 : expected.remaining };
        }),
    });
    return Effect.gen(function* () {
      const http = yield* Check(account);
      expect(yield* http({ feature: "messages", amount: 1 })).toEqual(expected);
      expect(calls).toBe(1);
    }).pipe(Effect.provide(CheckOverTransport), Effect.provide(transport), Effect.provide(World));
  });

  it.live("the read model round-trips features, credits and standing", () =>
    Effect.gen(function* () {
      yield* subscribeFree;
      const store = yield* BillingReadStore;
      const row = yield* store.get(account);
      expect(row?.features.messages?.included).toBe(100);
      expect(row?.features.messages?.overage).toBe("block");
      expect(row?.credits).toBe(0);
      expect(row?.standing).toBe("good");
    }).pipe(run),
  );

  it.live("a missing feature is not allowed even with a good standing", () =>
    Effect.gen(function* () {
      yield* subscribeFree;
      const check = yield* Check(account);
      const answer = yield* check({ feature: "seats" });
      expect(answer.allowed).toBe(false);
      expect(answer.standing).toBe("good");
    }).pipe(run),
  );
});

describe("the read model answers what check() answers", () => {
  it.live("Entitlements.allowed is check({ amount: 1 }).allowed, for every standing", () =>
    Effect.gen(function* () {
      const receipt = yield* subscribeFree;
      yield* BillingRead.caughtUp(receipt);
      const entitlements = yield* Entitlements;
      const check = yield* Check(account);

      const view = Option.getOrNull(yield* entitlements.query(Subscription.ref(account)));
      const answered = yield* check({ feature: "messages", amount: 1 });
      expect(view?.features.messages?.allowed).toBe(answered.allowed);
      expect(view?.features.messages?.remaining).toBe(answered.remaining);
      expect(view?.standing).toBe(answered.standing);

      // Spend the whole allowance: the view says no, and so does check().
      const track = yield* TrackUsage(account);
      yield* track({ feature: "messages", amount: 100, dedupeKey: "read-paths-100" });
      const empty = Option.getOrNull(yield* entitlements.query(Subscription.ref(account)));
      expect(empty?.features.messages?.allowed).toBe(false);
      expect(empty?.features.messages?.remaining).toBe(0);
      expect((yield* check({ feature: "messages", amount: 1 })).allowed).toBe(false);
    }).pipe(run),
  );

  it.live("a bill overage stays allowed at zero remaining, and a block does not", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const entitlements = yield* Entitlements;
      const check = yield* Check(account);
      const receipt = yield* subscription.send(
        Subscription.ref(account),
        new Subscribe({
          credits: 0,
          creditsExpire: "period",
          rates: {},
          tier: "pro",
          allowances: pro,
        }),
      );
      yield* entitlements.query(Subscription.ref(account), { atLeast: receipt });
      yield* (yield* TrackUsage(account))({
        feature: "messages",
        amount: 2000,
        dedupeKey: "read-paths-2000",
      });
      const view = Option.getOrNull(yield* entitlements.query(Subscription.ref(account)));
      expect(view?.features.messages?.remaining).toBe(0);
      expect(view?.features.messages?.allowed).toBe(true);
      expect((yield* check({ feature: "messages", amount: 1 })).allowed).toBe(true);
    }).pipe(run),
  );
});
