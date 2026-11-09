import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { Attach } from "../../src/Billing/Attach.binding.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { TrackUsage } from "../../src/Billing/TrackUsage.binding.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { AccountId } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

const storage = feature({ id: "storage", name: "Storage" });

const testCatalog = Effect.runSync(
  catalog({
    features: [messages, storage],
    tiers: [
      tier({
        id: "base",
        grants: [allowance(storage, { included: 10 })],
      }),
      // Two bespoke add-ons granting the same feature. The catalog's grants are
      // only their quotes; the attach below states a different set for each.
      tier({
        id: "bolt-on-a",
        custom: true,
        addOn: true,
        grants: [allowance(messages, { included: 100 })],
      }),
      tier({
        id: "bolt-on-b",
        custom: true,
        addOn: true,
        grants: [allowance(messages, { included: 100 })],
      }),
    ],
  }),
);

const account = "acct_custom_balance" as AccountId;
const ref = Subscription.ref(account);

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

const world = Layer.mergeAll(
  BillingInProcess,
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(Layer.provideMerge(Model));

describe("a bespoke add-on balance", () => {
  it.live("is its own plan source, and a spend consumes the plan sources in plan-set order", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "base", idempotencyKey: "balance-base" });
      yield* attach({
        planId: "bolt-on-a",
        grants: [allowance(messages, { included: 200 })],
        idempotencyKey: "balance-bolt-on-a",
      });
      yield* attach({
        planId: "bolt-on-b",
        grants: [allowance(messages, { included: 300 })],
        idempotencyKey: "balance-bolt-on-b",
      });

      const check = yield* Check(account);
      const entitlements = yield* Entitlements;

      const view = () =>
        Effect.gen(function* () {
          const state = Option.getOrNull(yield* entitlements.query(ref));

          return state?.features.messages ?? null;
        });

      const before = yield* check({ featureId: "messages" });
      const beforeView = yield* view();

      // Each add-on is a row of its own: the customer-level read is not one
      // merged count, and the second add-on does not reset the first's balance.
      expect(before.balance.granted).toBe(500);
      expect(before.balance.remaining).toBe(500);
      expect(before.balance.breakdown.map((row) => row.kind)).toEqual(["plan", "plan"]);
      expect(before.balance.breakdown.map((row) => row.planId)).toEqual(["bolt-on-a", "bolt-on-b"]);
      expect(before.balance.breakdown.map((row) => row.granted)).toEqual([200, 300]);
      expect(before.balance.breakdown.map((row) => row.remaining)).toEqual([200, 300]);
      expect(before.balance.breakdown.map((row) => row.usage)).toEqual([0, 0]);
      expect(before.balance.breakdown.map((row) => row.interval)).toEqual(["month", "month"]);
      expect(before.allowed).toBe(beforeView?.allowed);

      const track = yield* TrackUsage(account);

      const used = yield* track({
        featureId: "messages",
        value: 150,
        idempotencyKey: "balance-use-150",
      });

      // The spend takes the first add-on before the second. No row absorbs a
      // later plan's deficit.
      expect(used.balance.remaining).toBe(350);
      expect(used.balance.breakdown.map((row) => row.remaining)).toEqual([50, 300]);
      expect(used.balance.breakdown.map((row) => row.usage)).toEqual([150, 0]);

      const after = yield* check({ featureId: "messages" });
      const afterView = yield* view();

      expect(after.balance.remaining).toBe(350);
      expect(after.balance.breakdown.map((row) => row.remaining)).toEqual([50, 300]);
      expect(after.allowed).toBe(afterView?.allowed);
      expect(after.balance.remaining).toBe(afterView?.remaining);

      const exhausted = yield* track({
        featureId: "messages",
        value: 350,
        idempotencyKey: "balance-use-350",
      });

      expect(exhausted.balance.remaining).toBe(0);
      expect(exhausted.balance.breakdown.map((row) => row.remaining)).toEqual([0, 0]);
      expect(exhausted.balance.breakdown.map((row) => row.usage)).toEqual([200, 300]);

      const blocked = yield* check({ featureId: "messages" });
      const blockedView = yield* view();

      expect(blocked.allowed).toBe(false);
      expect(blocked.allowed).toBe(blockedView?.allowed);
    }).pipe(Effect.provide(world)),
  );
});
