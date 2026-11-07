import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AdminRefund, AdminRefundLive } from "../../src/Admin/Refund.ts";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { BillingAdminInProcess, EnterGrace, RecordPayment } from "../../src/Billing/index.ts";
import { subscribeOperation } from "../../src/Billing/Subscribe.operation.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { paymentsRouter } from "../../src/Payments.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import type { AccountId } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

const testCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [tier({ id: "free", grants: [allowance(messages, { included: 100 })] })],
  }),
);

const account = "acct_refund_rpc" as AccountId;

const Model = PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
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

/** The console server's world: the model, the operator bindings and the money. */
const world = (memory: ReturnType<typeof PaymentsMemory>) =>
  AdminRefundLive.pipe(
    Layer.provideMerge(BillingAdminInProcess),
    Layer.provideMerge(Model),
    Layer.provide(paymentsRouter(memory)),
  );

/** The same without a provider, to prove a missing capability is a tag. */
const localOnly = AdminRefundLive.pipe(
  Layer.provideMerge(BillingAdminInProcess),
  Layer.provideMerge(Model),
);

const subscribe = Effect.gen(function* () {
  const subscribe = yield* subscribeOperation();
  yield* subscribe({ account, tier: "free" });
});

const charge = (amount: number, dedupeKey: string) =>
  Effect.gen(function* () {
    const enterGrace = yield* EnterGrace(account);
    const recordPayment = yield* RecordPayment(account);
    yield* enterGrace({
      graceUntil: DateTime.add(DateTime.makeUnsafe(Date.now()), { days: 7 }),
      dedupeKey: `${dedupeKey}-grace`,
    });
    yield* recordPayment({ amount, currency: "usd", dedupeKey });
  });

describe("the console refund RPC", () => {
  it.live("takes money through the in-process binding and records it once", () => {
    const memory = PaymentsMemory();
    return Effect.gen(function* () {
      yield* subscribe;
      yield* charge(1_900, "pay-1");
      const refund = yield* AdminRefund;

      const first = yield* refund.refund({
        account,
        chargeId: "ch_1",
        amount: 1_000,
        currency: "usd",
        reason: "duplicate order",
        commandId: "refund-1",
      });
      expect(first._tag).toBe("applied");
      if (first._tag !== "applied") return;
      expect(first.refundId.length).toBeGreaterThan(0);
      expect(first.refunded).toBe(1_000);
      expect(memory.refunds.length).toBe(1);

      // The console's command id is the provider's idempotency key: a retry
      // after an unknown outcome answers the first refund, not a second.
      const retried = yield* refund.refund({
        account,
        chargeId: "ch_1",
        amount: 1_000,
        currency: "usd",
        reason: "duplicate order",
        commandId: "refund-1",
      });
      expect(retried).toEqual(first);
      expect(memory.refunds.length).toBe(1);

      // 900 is left, so 901 is refused before the provider is asked.
      const tooMuch = yield* refund.refund({
        account,
        chargeId: "ch_1",
        amount: 901,
        currency: "usd",
        commandId: "refund-2",
      });
      expect(tooMuch._tag).toBe("rejected");
      if (tooMuch._tag === "rejected") {
        expect(tooMuch.rejection._tag).toBe("RefundExceedsCharged");
      }
      expect(memory.refunds.length).toBe(1);
    }).pipe(Effect.provide(world(memory)));
  });

  it.live("answers ProviderCapabilityMissing when the process has no provider", () =>
    Effect.gen(function* () {
      yield* subscribe;
      yield* charge(1_900, "pay-2");
      const refund = yield* AdminRefund;
      const answer = yield* refund.refund({
        account,
        chargeId: "ch_1",
        amount: 1_000,
        currency: "usd",
        commandId: "refund-3",
      });
      expect(answer._tag).toBe("rejected");
      if (answer._tag === "rejected") {
        expect(answer.rejection._tag).toBe("ProviderCapabilityMissing");
      }
    }).pipe(Effect.provide(localOnly)),
  );

  it.live("allocates a command id when the caller omits one", () => {
    const memory = PaymentsMemory();
    return Effect.gen(function* () {
      yield* subscribe;
      yield* charge(1_900, "pay-4");
      const refund = yield* AdminRefund;
      const answer = yield* refund.refund({
        account,
        chargeId: "ch_1",
        amount: 500,
        currency: "usd",
      });
      expect(answer._tag).toBe("applied");
      if (answer._tag === "applied") expect(answer.commandId.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(world(memory)));
  });
});
