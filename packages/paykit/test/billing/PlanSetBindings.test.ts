import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { AddAddOn } from "../../src/Billing/AddAddOn.binding.ts";
import { Attach } from "../../src/Billing/Attach.binding.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { MultiAttach, MultiUpdate } from "../../src/Billing/MultiPlan.binding.ts";
import { PlanOperationUnsupported } from "../../src/Billing/PlanOperationUnsupported.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  addOnsOf,
  planOfGroup,
  planRowsOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

const support = feature({ id: "support", name: "Support" });
const analytics = feature({ id: "analytics", name: "Analytics" });

const testCatalog = Effect.runSync(
  catalog({
    features: [messages, support, analytics],
    tiers: [
      tier({
        id: "pro",
        isDefault: true,
        grants: [allowance(messages, { included: 2_000, overage: "bill" })],
      }),
      tier({
        id: "support",
        group: "support",
        grants: [allowance(support, { included: 5, overage: "block" })],
      }),
      tier({
        id: "support-free",
        group: "support",
        isDefault: true,
        grants: [allowance(support, { included: 1, overage: "block" })],
      }),
      tier({
        id: "analytics",
        addOn: true,
        grants: [allowance(analytics, { included: 10 })],
      }),
    ],
  }),
);

const account = "acct_plan_set_bindings";

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

const stateOf = Effect.gen(function* () {
  const subscription = yield* Subscription;

  return (yield* subscription.state(Subscription.ref(account))) as SubscribedState;
});

describe("multi-plan bindings", () => {
  it.live("attaches two plans under one command id", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      yield* attach({ planId: "pro", idempotencyKey: "start" });

      const multi = yield* MultiAttach(account);

      const result = yield* multi({
        plans: [{ planId: "support" }, { planId: "analytics" }],
        idempotencyKey: "multi-1",
      });

      expect(result.outcome).toBe("changed");
      expect(result.planIds).toEqual(["support", "analytics"]);

      const state = yield* stateOf;
      expect(planRowsOf(state)).toHaveLength(3);
      expect(planOfGroup(state, "support")?.planId).toBe("support");
      expect(addOnsOf(state).map((row) => row.planId)).toEqual(["analytics"]);
    }).pipe(Effect.provide(world)),
  );

  it.live("cancels a group in the same transaction as a phase", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      yield* attach({ planId: "pro", idempotencyKey: "start-update" });

      const multi = yield* MultiAttach(account);
      yield* multi({
        plans: [{ planId: "support" }],
        idempotencyKey: "multi-support",
      });

      const update = yield* MultiUpdate(account);

      const result = yield* update({
        plans: [],
        cancels: [{ group: "support" }],
        idempotencyKey: "multi-update",
      });

      expect(result.outcome).toBe("updated");

      const state = yield* stateOf;
      expect(state.cancellations?.support?.planId).toBe("support");
      // The fallback is the catalog's default for the group.
      expect(state.cancellations?.support?.fallback?.planId).toBe("support-free");
    }).pipe(Effect.provide(world)),
  );
});

describe("addAddOn", () => {
  it.live("stacks an add-on and refuses a plan that fills a group", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      yield* attach({ planId: "pro", idempotencyKey: "start-add" });

      const addAddOn = yield* AddAddOn(account);
      const added = yield* addAddOn({ planId: "analytics", idempotencyKey: "addon-1" });
      expect(added).toEqual({ outcome: "added", planId: "analytics" });

      const state = yield* stateOf;
      expect(addOnsOf(state).map((row) => row.planId)).toEqual(["analytics"]);

      const refused = yield* addAddOn({ planId: "support", idempotencyKey: "addon-2" }).pipe(
        Effect.flip,
      );

      expect(refused).toBeInstanceOf(PlanOperationUnsupported);
    }).pipe(Effect.provide(world)),
  );
});
