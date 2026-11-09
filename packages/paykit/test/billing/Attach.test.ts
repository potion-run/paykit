import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { Attach, PreviewAttach, PreviewUpdate, Update } from "../../src/Billing/Attach.binding.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { Webhook } from "../../src/Billing/Webhook.binding.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { AccountId } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

const testCatalog = Effect.runSync(
  catalog({
    features: [messages, seats],
    tiers: [
      tier({
        id: "free",
        credits: 100,
        grants: [
          allowance(messages, { included: 100 }),
          allowance(seats, {
            included: 2,
            overage: "bill",
            cap: 10,
            unitPrice: { amount: 10, currency: "usd" },
          }),
        ],
      }),
      tier({
        id: "pro",
        price: { amount: 1_900, currency: "usd", interval: "month" },
        credits: 5_000,
        grants: [
          allowance(messages, { included: 2_000 }),
          allowance(seats, {
            included: 2,
            overage: "bill",
            cap: 10,
            unitPrice: { amount: 10, currency: "usd" },
          }),
        ],
      }),
      tier({
        id: "scale",
        price: { amount: 9_900, currency: "usd", interval: "month" },
        credits: 10_000,
        grants: [
          allowance(messages, { included: 5_000 }),
          allowance(seats, {
            included: 5,
            overage: "bill",
            cap: 20,
            unitPrice: { amount: 10, currency: "usd" },
          }),
        ],
      }),
    ],
  }),
);

const account = "acct_attach" as AccountId;

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

const memory = PaymentsMemory();

const world = Layer.mergeAll(BillingInProcess, catalogLayer(testCatalog), memory.payments).pipe(
  Layer.provideMerge(Model),
);

const stateOf = Effect.gen(function* () {
  const subscription = yield* Subscription;

  return yield* subscription.state(Subscription.ref(account));
});

describe("billing.attach", () => {
  it.live("activates a new plan", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const result = yield* attach({ planId: "free", idempotencyKey: "attach-free" });

      expect(result.outcome).toBe("activated");
      expect(result.planId).toBe("free");

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.tier : null).toBe("free");
    }).pipe(Effect.provide(world)),
  );

  it.live("moves to a bigger plan immediately and collects the proration", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "attach-free-2" });
      const result = yield* attach({ planId: "pro", idempotencyKey: "attach-pro" });

      expect(result.outcome).toBe("changed");
      expect(result.planId).toBe("pro");
      expect(result.proration?.due).toBeGreaterThan(0);

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.tier : null).toBe("pro");
      expect(state._tag === "Subscribed" ? state.pendingTier : null).toBeUndefined();
    }).pipe(Effect.provide(world)),
  );

  it.live("schedules a smaller plan for the boundary", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "attach-free-4" });
      yield* attach({ planId: "pro", idempotencyKey: "attach-pro-2" });
      const down = yield* attach({ planId: "free", idempotencyKey: "attach-down" });

      expect(down.outcome).toBe("scheduled");
      expect(down.planId).toBe("pro");
      expect(down.pendingPlanId).toBe("free");

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.tier : null).toBe("pro");
      expect(state._tag === "Subscribed" ? state.pendingTier?.tier : null).toBe("free");
    }).pipe(Effect.provide(world)),
  );

  it.live("treats the same plan as a replay and still sets quantities", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "attach-free-6" });

      const again = yield* attach({
        planId: "free",
        idempotencyKey: "attach-free-7",
        featureQuantities: [{ featureId: "seats", quantity: 5 }],
      });

      expect(again.outcome).toBe("updated");

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.quantities?.seats : null).toBe(5);
    }).pipe(Effect.provide(world)),
  );

  it.live("treats the same plan as a replay", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "attach-free-3" });
      const again = yield* attach({ planId: "free", idempotencyKey: "attach-free-3" });

      expect(again.outcome).toBe("updated");
      expect(again.planId).toBe("free");
    }).pipe(Effect.provide(world)),
  );

  it.live("sets feature quantities in the same operation", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({
        planId: "free",
        idempotencyKey: "attach-seats",
        featureQuantities: [{ featureId: "seats", quantity: 4 }],
      });

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.quantities?.seats : null).toBe(4);
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses quantities on a scheduled change", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "attach-free-5" });
      yield* attach({ planId: "pro", idempotencyKey: "attach-pro-3" });

      const refused = yield* Effect.exit(
        attach({
          planId: "free",
          idempotencyKey: "attach-down-seats",
          featureQuantities: [{ featureId: "seats", quantity: 3 }],
        }),
      );

      expect(refused._tag).toBe("Failure");

      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("PlanOperationUnsupported");
      }

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.pendingTier : null).toBeUndefined();
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses a plan the catalog does not sell", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const refused = yield* Effect.exit(
        attach({ planId: "missing", idempotencyKey: "attach-missing" }),
      );

      expect(refused._tag).toBe("Failure");

      if (refused._tag === "Failure") expect(String(refused.cause)).toContain("PlanNotInCatalog");
    }).pipe(Effect.provide(world)),
  );
});

describe("billing.update", () => {
  it.live("sets quantities on a running plan", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const update = yield* Update(account);

      yield* attach({ planId: "free", idempotencyKey: "u-free" });

      const result = yield* update({
        idempotencyKey: "u-seats",
        featureQuantities: [{ featureId: "seats", quantity: 5 }],
      });

      expect(result.outcome).toBe("updated");

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.quantities?.seats : null).toBe(5);
    }).pipe(Effect.provide(world)),
  );

  it.live("cancels at the boundary and drops a pending plan", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const update = yield* Update(account);

      yield* attach({ planId: "free", idempotencyKey: "u-free-2" });
      yield* attach({ planId: "pro", idempotencyKey: "u-pro" });
      yield* attach({ planId: "free", idempotencyKey: "u-down" });

      const result = yield* update({
        idempotencyKey: "u-cancel",
        cancelAction: "cancel_end_of_cycle",
      });

      expect(result.outcome).toBe("canceled");

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.cancelAtPeriodEnd : null).toBe(true);
      expect(state._tag === "Subscribed" ? state.pendingTier : null).toBeUndefined();
    }).pipe(Effect.provide(world)),
  );

  it.live("uncancels a pending plan", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const update = yield* Update(account);

      yield* attach({ planId: "free", idempotencyKey: "u-free-3" });
      yield* attach({ planId: "pro", idempotencyKey: "u-pro-2" });
      yield* attach({ planId: "free", idempotencyKey: "u-down-2" });

      const result = yield* update({ idempotencyKey: "u-uncancel", cancelAction: "uncancel" });

      expect(result.outcome).toBe("uncanceled");

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.pendingTier : null).toBeUndefined();
    }).pipe(Effect.provide(world)),
  );

  it.live("uncancels a pending cancellation", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const update = yield* Update(account);

      yield* attach({ planId: "free", idempotencyKey: "u-free-4" });
      yield* update({ idempotencyKey: "u-cancel-2", cancelAction: "cancel_end_of_cycle" });
      const result = yield* update({ idempotencyKey: "u-uncancel-2", cancelAction: "uncancel" });

      expect(result.outcome).toBe("uncanceled");

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.cancelAtPeriodEnd : null).toBe(false);
    }).pipe(Effect.provide(world)),
  );

  it.live("cancels immediately and refunds the unused plan charge", () =>
    Effect.gen(function* () {
      const webhook = yield* Webhook();
      const update = yield* Update(account);

      yield* webhook({
        id: "evt_paid",
        provider: "memory",
        kind: "checkout_completed",
        account,
        tier: "pro",
        chargeId: "ch_plan_1",
      });

      const before = yield* stateOf;
      expect(before._tag === "Subscribed" ? before.lastChargeId : null).toBe("ch_plan_1");
      expect(before._tag === "Subscribed" ? before.charged?.usd : null).toBe(1_900);

      const result = yield* update({
        idempotencyKey: "cancel-now",
        cancelAction: "cancel_immediately",
      });

      expect(result.outcome).toBe("canceled");
      expect(result.refunded).toBe(1_900);
      expect(result.refundId).toBeDefined();

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.status : null).toBe("canceled");
      expect(state._tag === "Subscribed" ? state.pendingTier : null).toBeUndefined();
      expect(state._tag === "Subscribed" ? state.refunded?.usd : null).toBe(1_900);
      expect(memory.refunds).toHaveLength(1);
      expect(memory.refunds[0]?.chargeId).toBe("ch_plan_1");
      expect(memory.refunds[0]?.amount).toBe(1_900);
    }).pipe(Effect.provide(world)),
  );
  it.live("cancels a free plan immediately without a refund", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const update = yield* Update(account);

      yield* attach({ planId: "free", idempotencyKey: "u-free-5" });

      const result = yield* update({
        idempotencyKey: "u-cancel-now",
        cancelAction: "cancel_immediately",
      });

      expect(result.outcome).toBe("canceled");
      expect(result.refunded).toBeUndefined();

      const state = yield* stateOf;
      expect(state._tag === "Subscribed" ? state.status : null).toBe("canceled");
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses an update with no standing", () =>
    Effect.gen(function* () {
      const update = yield* Update(account);
      const refused = yield* Effect.exit(update({ idempotencyKey: "u-none" }));

      expect(refused._tag).toBe("Failure");

      if (refused._tag === "Failure") expect(String(refused.cause)).toContain("NotSubscribed");
    }).pipe(Effect.provide(world)),
  );
});

describe("plan previews", () => {
  it.live("previews a new activation", () =>
    Effect.gen(function* () {
      const preview = yield* PreviewAttach(account);
      const answer = yield* preview({ planId: "free" });

      expect(answer.outcome).toBe("activated");
      expect(answer.preview?._tag).toBe("accepted");
    }).pipe(Effect.provide(world)),
  );

  it.live("previews an upgrade and its proration", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const preview = yield* PreviewAttach(account);

      yield* attach({ planId: "free", idempotencyKey: "p-free" });
      const answer = yield* preview({ planId: "pro" });

      expect(answer.outcome).toBe("changed");
      expect(answer.preview?._tag).toBe("accepted");

      if (answer.preview?._tag === "accepted") {
        expect(answer.preview.proration?.due).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(world)),
  );

  it.live("previews a scheduled downgrade", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const preview = yield* PreviewAttach(account);

      yield* attach({ planId: "free", idempotencyKey: "p-free-2" });
      yield* attach({ planId: "pro", idempotencyKey: "p-pro" });
      const answer = yield* preview({ planId: "free" });

      expect(answer.outcome).toBe("scheduled");
      expect(answer.pendingPlanId).toBe("free");
      expect(answer.preview?._tag).toBe("accepted");
    }).pipe(Effect.provide(world)),
  );

  it.live("previews a quantity update", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const preview = yield* PreviewUpdate(account);

      yield* attach({ planId: "free", idempotencyKey: "p-free-3" });

      const answer = yield* preview({
        featureQuantities: [{ featureId: "seats", quantity: 5 }],
      });

      expect(answer.previews).toHaveLength(1);
      expect(answer.previews[0]?._tag).toBe("accepted");
    }).pipe(Effect.provide(world)),
  );

  it.live("previews a cancellation and the pending plan it drops", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const preview = yield* PreviewUpdate(account);

      yield* attach({ planId: "free", idempotencyKey: "p-free-4" });
      yield* attach({ planId: "pro", idempotencyKey: "p-pro-2" });
      yield* attach({ planId: "free", idempotencyKey: "p-down" });

      const answer = yield* preview({ cancelAction: "cancel_end_of_cycle" });

      expect(answer.previews).toHaveLength(2);
      expect(answer.previews.every((entry) => entry._tag === "accepted")).toBe(true);
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses to preview an immediate cancellation", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const preview = yield* PreviewUpdate(account);

      yield* attach({ planId: "free", idempotencyKey: "p-free-5" });
      const refused = yield* Effect.exit(preview({ cancelAction: "cancel_immediately" }));

      expect(refused._tag).toBe("Failure");

      if (refused._tag === "Failure") {
        expect(String(refused.cause)).toContain("PlanOperationUnsupported");
      }
    }).pipe(Effect.provide(world)),
  );
});
