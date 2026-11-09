import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { Balances } from "../../src/Billing/Balances.binding.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { BillingCommandsLive } from "../../src/Billing/Commands.rpc.ts";
import { SetQuantity } from "../../src/Billing/SetQuantity.binding.ts";
import { subscribeOperation } from "../../src/Billing/Subscribe.operation.ts";
import { TrackUsage } from "../../src/Billing/TrackUsage.binding.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import type { AccountId } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });
const extra = feature({ id: "extra", name: "Extra" });

/** 5 free seats, $10 each, never more than 20 bought. */
const testCatalog = Effect.runSync(
  catalog({
    features: [messages, seats, extra],
    tiers: [
      tier({
        id: "team",
        grants: [
          allowance(messages, { included: 100 }),
          allowance(seats, {
            included: 5,
            overage: "bill",
            unitPrice: { amount: 1_000, currency: "usd" },
            cap: 20,
          }),
        ],
      }),
    ],
  }),
);

const account = "acct_balances" as AccountId;

const Model = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InsecureDevGuards,
        CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
      ),
    ),
  );

const inProcessWorld = Layer.mergeAll(
  BillingInProcess,
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(Layer.provideMerge(Model));

const apiWorld = Layer.mergeAll(
  BillingApiLayer.pipe(Layer.provideMerge(BillingCommandsLive)),
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(
  Layer.provide(BillingApi.layerClientInProcess),
  Layer.provideMerge(Model),
  Layer.provide(Layer.succeed(BindingCall, { headers: { "x-paykit-actor": account } })),
);

type World = Layer.Success<typeof apiWorld>;

const both = <A, E>(name: string, body: () => Effect.Effect<A, E, World>) => {
  it.live(`${name} over the model`, () => body().pipe(Effect.provide(inProcessWorld)));
  it.live(`${name} over the Api`, () => body().pipe(Effect.provide(apiWorld)));
};

/** Subscribe to the only plan, so every test starts on the same standing. */
const subscribe = (accountId: AccountId) =>
  Effect.gen(function* () {
    const subscribe = yield* subscribeOperation();

    yield* subscribe({ account: accountId, tier: "team" });
  });

const subscribeTeam = subscribe(account);

describe("balances", () => {
  both("lists every feature and answers one with its plan source", () =>
    Effect.gen(function* () {
      yield* subscribeTeam;
      const balances = yield* Balances(account);

      const all = yield* balances.list();
      expect(all.map((balance) => balance.featureId).sort()).toEqual(["messages", "seats"]);

      const seatBalance = yield* balances.get({ featureId: "seats" });
      expect(seatBalance.purchased).toBe(5);
      expect(seatBalance.occupied).toBe(0);
      expect(seatBalance.remaining).toBe(5);
      expect(seatBalance.breakdown[0]?.planId).toBe("team");
      expect(seatBalance.breakdown[0]?.kind).toBe("plan");
    }),
  );

  both("refuses a balance the customer does not hold", () =>
    Effect.gen(function* () {
      yield* subscribeTeam;
      const balances = yield* Balances(account);

      const refused = yield* Effect.flip(balances.get({ featureId: "storage" }));
      expect(refused._tag).toBe("BalanceNotFound");
    }),
  );

  both("creates a lifetime grant, and the plan is spent first", () =>
    Effect.gen(function* () {
      yield* subscribeTeam;
      const balances = yield* Balances(account);
      const track = yield* TrackUsage(account);

      const granted = yield* balances.create({
        featureId: "messages",
        grantedBalance: 50,
        idempotencyKey: "grant:1",
      });

      expect(granted.remaining).toBe(150);
      expect(granted.breakdown.some((source) => source.kind === "grant")).toBe(true);

      const used = yield* track({
        featureId: "messages",
        value: 120,
        idempotencyKey: "use:grant",
      });

      expect(used.balance.remaining).toBe(30);
      expect(used.balance.breakdown.find((source) => source.kind === "grant")?.remaining).toBe(30);
      expect(used.balance.breakdown.find((source) => source.kind === "plan")?.remaining).toBe(0);

      // A feature the plan does not grant can be funded by a grant alone.
      const extraGrant = yield* balances.create({
        featureId: "extra",
        grantedBalance: 5,
        idempotencyKey: "grant:extra",
      });

      expect(extraGrant.remaining).toBe(5);
      expect(extraGrant.breakdown.map((source) => source.kind)).toEqual(["grant"]);

      const extraUsed = yield* track({
        featureId: "extra",
        value: 2,
        idempotencyKey: "use:extra",
      });

      expect(extraUsed.balance.remaining).toBe(3);
    }),
  );

  both("writes occupancy without billing or changing the purchase", () =>
    Effect.gen(function* () {
      yield* subscribeTeam;
      const balances = yield* Balances(account);
      const check = yield* Check(account);

      const updated = yield* balances.update({ featureId: "seats", usage: 3 });
      expect(updated.purchased).toBe(5);
      expect(updated.occupied).toBe(3);
      expect(updated.remaining).toBe(2);

      const after = yield* check({ featureId: "seats", requiredBalance: 3 });
      expect(after.allowed).toBe(false);
      expect(after.balance.remaining).toBe(2);

      // Occupancy is a set, not an increment: going away and back records the
      // value again rather than replaying the first command id.
      const five = yield* balances.update({ featureId: "seats", usage: 5 });
      expect(five.occupied).toBe(5);

      const back = yield* balances.update({ featureId: "seats", usage: 3 });
      expect(back.occupied).toBe(3);
      expect(back.remaining).toBe(2);
    }),
  );

  both("lets a purchase drop below occupancy and blocks the next seat", () =>
    Effect.gen(function* () {
      yield* subscribeTeam;
      const balances = yield* Balances(account);
      const setQuantity = yield* SetQuantity(account);
      const check = yield* Check(account);

      yield* balances.update({ featureId: "seats", usage: 8 });

      // Buying fewer seats than are occupied is allowed: nobody loses a seat.
      const bought = yield* setQuantity({
        feature: "seats",
        quantity: 3,
        dedupeKey: "seats:down",
      });

      expect(bought.quantity).toBe(3);

      const negative = yield* balances.get({ featureId: "seats" });
      expect(negative.purchased).toBe(3);
      expect(negative.occupied).toBe(8);
      expect(negative.remaining).toBe(-5);

      const refused = yield* check({ featureId: "seats", requiredBalance: 1 });
      expect(refused.allowed).toBe(false);
    }),
  );

  both("commits a lock for what ran and returns the rest", () =>
    Effect.gen(function* () {
      yield* subscribeTeam;
      const balances = yield* Balances(account);
      const check = yield* Check(account);

      const locked = yield* check({
        featureId: "messages",
        requiredBalance: 40,
        lock: true,
        idempotencyKey: "turn-1",
      });

      expect(locked.allowed).toBe(true);
      expect(locked.lockId).toBe("turn-1");
      expect(locked.balance.remaining).toBe(60);

      const finalized = yield* balances.finalize({
        lockId: "turn-1",
        action: "commit",
        overrideValue: 10,
      });

      expect(finalized.remaining).toBe(90);
      expect(finalized.usage).toBe(10);
    }),
  );

  both("releases a lock without billing it", () =>
    Effect.gen(function* () {
      yield* subscribeTeam;
      const balances = yield* Balances(account);
      const check = yield* Check(account);

      const locked = yield* check({
        featureId: "messages",
        requiredBalance: 40,
        lock: true,
        idempotencyKey: "job-1",
      });

      expect(locked.balance.remaining).toBe(60);

      const released = yield* balances.finalize({ lockId: "job-1", action: "release" });
      expect(released.remaining).toBe(100);
      expect(released.usage).toBe(0);
    }),
  );

  both("refuses a lock without an id", () =>
    Effect.gen(function* () {
      yield* subscribeTeam;
      const check = yield* Check(account);

      const refused = yield* Effect.flip(
        check({ featureId: "messages", requiredBalance: 1, lock: true }),
      );

      expect(refused._tag).toBe("CheckLockKeyMissing");
    }),
  );
});
