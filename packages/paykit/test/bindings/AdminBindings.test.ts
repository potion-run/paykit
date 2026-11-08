import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import {
  BillingAdminApiLayer,
  BillingAdminInProcess,
  BillingApiLayer,
  BillingInProcess,
  BindingCall,
  EnterGrace,
  Expire,
  ExtendTrial,
  GrantCredits,
  RecordPayment,
  RecordPaymentFailure,
  Recover,
  Refund,
} from "../../src/Billing/index.ts";
import { subscribeOperation } from "../../src/Billing/Subscribe.operation.ts";
import { BillingAdminApi } from "../../src/BillingAdminApi.api.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
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
    tiers: [tier({ id: "free", credits: 100, grants: [allowance(messages, { included: 100 })] })],
  }),
);

const account = "acct_admin_binding" as AccountId;
const operator = { headers: { "x-paykit-actor": "ops_1", "x-paykit-kind": "admin" } };

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

/** The operator surface in the process that hosts the model. */
const adminInProcessWorld = Layer.mergeAll(BillingAdminInProcess, catalogLayer(testCatalog)).pipe(
  Layer.provideMerge(Model),
);

/**
 * The in-process operator layer with a provider behind it. `Refund` is not on
 * the admin Api (a console backend cannot take money out), so it is only here.
 */
/**
 * The in-process operator layer with one provider behind it. The router has to
 * be in the layer's own environment, not merged beside it: `BillingAdminInProcess`
 * resolves it while the layer is built. Built per test, because the fake
 * provider records what it was asked and the runner may retry a case.
 */
const adminWithPayments = (memory: ReturnType<typeof PaymentsMemory>) =>
  Layer.merge(BillingAdminInProcess, catalogLayer(testCatalog)).pipe(
    Layer.provideMerge(Model),
    Layer.provide(paymentsRouter(memory)),
  );

/** The same, over the admin Api: its `Admin` middleware is on the path. */
const adminApiWorld = Layer.mergeAll(BillingAdminApiLayer, catalogLayer(testCatalog)).pipe(
  Layer.provide(BillingAdminApi.layerClientInProcess),
  Layer.provideMerge(Model),
  Layer.provide(Layer.succeed(BindingCall, operator)),
);

/** The tenant surfaces, to prove they do not carry the operator commands. */
const tenantInProcessWorld = Layer.mergeAll(BillingInProcess, catalogLayer(testCatalog)).pipe(
  Layer.provideMerge(Model),
);

const tenantApiWorld = Layer.mergeAll(BillingApiLayer, catalogLayer(testCatalog)).pipe(
  Layer.provide(BillingApi.layerClientInProcess),
  Layer.provideMerge(Model),
  Layer.provide(Layer.succeed(BindingCall, { headers: { "x-paykit-actor": account } })),
);

const subscribe = Effect.gen(function* () {
  const subscribe = yield* subscribeOperation();
  yield* subscribe({ account, tier: "free" });
});

/** One story, both operator transports. */
const both = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, Layer.Success<typeof adminApiWorld>>,
) => {
  it.live(`${name} in process`, () => body().pipe(Effect.provide(adminInProcessWorld)));
  it.live(`${name} over the admin Api`, () => body().pipe(Effect.provide(adminApiWorld)));
};

/** Is this binding in the context the layer built? */
const provided = <A extends { readonly key: string }>(tag: A) =>
  Effect.gen(function* () {
    // A tag is a value and a type at once; the helper only needs to know the
    // service is there, so the shape is erased at this one line.
    const held = yield* Effect.serviceOption(tag as never);

    return Option.isSome(held);
  });

const adminTags = [
  GrantCredits,
  ExtendTrial,
  EnterGrace,
  Recover,
  Expire,
  RecordPayment,
  RecordPaymentFailure,
] as const;

describe("the operator bindings", () => {
  it.live("the admin layer provides every operator binding", () =>
    Effect.gen(function* () {
      for (const tag of adminTags) {
        expect([tag.key, yield* provided(tag)]).toEqual([tag.key, true]);
      }
    }).pipe(Effect.provide(adminInProcessWorld)),
  );

  it.live("a tenant layer provides none of them", () =>
    Effect.gen(function* () {
      for (const tag of adminTags) {
        expect([tag.key, yield* provided(tag)]).toEqual([tag.key, false]);
      }
    }).pipe(Effect.provide(tenantInProcessWorld)),
  );

  it.live("no tenant Api layer provides them either", () =>
    Effect.gen(function* () {
      for (const tag of adminTags) {
        expect([tag.key, yield* provided(tag)]).toEqual([tag.key, false]);
      }
    }).pipe(Effect.provide(tenantApiWorld)),
  );

  both("grants credits and answers the balance the command recorded", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const grant = yield* GrantCredits(account);
      const granted = yield* grant({ amount: 250, dedupeKey: "grant-1" });
      expect(granted.balance).toBe(350);

      // Same key is the same command: a retry does not grant twice.
      expect((yield* grant({ amount: 250, dedupeKey: "grant-1" })).balance).toBe(350);
    }),
  );

  both("opens grace, then books the payment that ends it", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const enterGrace = yield* EnterGrace(account);
      const recordPayment = yield* RecordPayment(account);

      const deadline = DateTime.add(DateTime.makeUnsafe(Date.now()), { days: 7 });
      const graced = yield* enterGrace({ graceUntil: deadline, dedupeKey: "grace-1" });
      expect(graced.graceUntil).toBeDefined();

      // Recording the payment is what ends grace: the standing recovers in the
      // same command, which is why `recover` afterwards is `NotInGrace`.
      const paid = yield* recordPayment({ amount: 1900, currency: "usd", dedupeKey: "pay-1" });
      expect(paid.graceUntil).toBeUndefined();
    }),
  );

  both("recovers a standing by hand, and refuses once grace is already over", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const enterGrace = yield* EnterGrace(account);
      const recover = yield* Recover(account);

      yield* enterGrace({
        graceUntil: DateTime.add(DateTime.makeUnsafe(Date.now()), { days: 7 }),
        dedupeKey: "grace-2",
      });
      expect((yield* recover({ dedupeKey: "recover-2" })).graceUntil).toBeUndefined();

      const refused = yield* Effect.exit(recover({ dedupeKey: "recover-3" }));
      expect(refused._tag).toBe("Failure");

      if (refused._tag === "Failure") expect(String(refused.cause)).toContain("NotInGrace");
    }),
  );

  both("records a failed payment and expires the standing after grace", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const fail = yield* RecordPaymentFailure(account);
      const expire = yield* Expire(account);

      const deadline = DateTime.add(DateTime.makeUnsafe(Date.now()), { days: 7 });

      const failed = yield* fail({
        reason: "card_declined",
        graceUntil: deadline,
        dedupeKey: "fail-1",
      });

      expect(failed.dunningAttempts).toBeGreaterThan(0);
      expect(failed.graceUntil).toBeDefined();

      const expired = yield* expire({ dedupeKey: "expire-1" });
      expect(expired.status).toBe("expired");
    }),
  );

  both("refuses to extend a trial that is not running", () =>
    Effect.gen(function* () {
      yield* subscribe;
      const extend = yield* ExtendTrial(account);

      const refused = yield* Effect.exit(
        extend({
          trialEndsAt: DateTime.add(DateTime.makeUnsafe(Date.now()), { days: 3 }),
          dedupeKey: "extend-1",
        }),
      );

      expect(refused._tag).toBe("Failure");

      if (refused._tag === "Failure") expect(String(refused.cause)).toContain("TrialNotActive");
    }),
  );
});

describe("refunding a charge", () => {
  it.live("sends money back up to what the account was charged, once per dedupe key", () => {
    const memory = PaymentsMemory();

    return Effect.gen(function* () {
      yield* subscribe;
      const enterGrace = yield* EnterGrace(account);
      const recordPayment = yield* RecordPayment(account);
      const refund = yield* Refund(account);

      // Nothing has been charged yet, so there is no ceiling to spend.
      const refused = yield* Effect.exit(
        refund({ chargeId: "ch_1", amount: 100, currency: "usd", dedupeKey: "refund-0" }),
      );

      expect(refused._tag).toBe("Failure");

      if (refused._tag === "Failure")
        expect(String(refused.cause)).toContain("RefundExceedsCharged");
      // The refusal never reached the provider: no money left the account.
      expect(memory.refunds.length).toBe(0);

      // A payment is what makes money refundable.
      yield* enterGrace({
        graceUntil: DateTime.add(DateTime.makeUnsafe(Date.now()), { days: 7 }),
        dedupeKey: "grace-refund",
      });
      yield* recordPayment({ amount: 1_900, currency: "usd", dedupeKey: "pay-refund" });

      const first = yield* refund({
        chargeId: "ch_1",
        amount: 1_000,
        currency: "usd",
        reason: "duplicate order",
        dedupeKey: "refund-1",
      });

      expect(first.refunded).toBe(1_000);
      expect(first.refundId.length).toBeGreaterThan(0);

      // The same dedupe key is the same refund, at the provider and here.
      const retried = yield* refund({
        chargeId: "ch_1",
        amount: 1_000,
        currency: "usd",
        reason: "duplicate order",
        dedupeKey: "refund-1",
      });

      expect(retried.refundId).toBe(first.refundId);
      expect(memory.refunds.length).toBe(1);

      // 900 is left: 901 is refused before the provider is asked.
      const tooMuch = yield* Effect.exit(
        refund({ chargeId: "ch_1", amount: 901, currency: "usd", dedupeKey: "refund-2" }),
      );

      expect(tooMuch._tag).toBe("Failure");
      expect(memory.refunds.length).toBe(1);

      const rest = yield* refund({
        chargeId: "ch_1",
        amount: 900,
        currency: "usd",
        dedupeKey: "refund-3",
      });

      expect(rest.refunded).toBe(1_900);
      expect(memory.refunds.length).toBe(2);
    }).pipe(Effect.provide(adminWithPayments(memory)));
  });

  it.live(
    "is not on the admin Api layer, because only the model's process holds the provider",
    () =>
      Effect.gen(function* () {
        const held = yield* Effect.serviceOption(Refund as never);

        return Option.isSome(held);
      }).pipe(
        Effect.provide(adminApiWorld),
        Effect.map((held) => expect(held).toBe(false)),
      ),
  );
});
