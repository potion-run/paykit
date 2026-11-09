import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { allowance } from "../../src/Allowance.ts";
import { asSystem } from "../../src/Auth/Actor.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { Attach } from "../../src/Billing/Attach.binding.ts";
import { Balances } from "../../src/Billing/Balances.binding.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { Customers } from "../../src/Billing/Customers.binding.ts";
import { Hold } from "../../src/Billing/Hold.binding.ts";
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
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { SetBillingControls as SetBillingControlsCommand } from "../../src/Subscription/SetBillingControls.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { AccountId } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

const requests = feature({ id: "requests", name: "Requests" });
const support = feature({ id: "support", name: "Support" });
const storage = feature({ id: "storage", name: "Storage" });
const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

/** `requests` is postpaid-priced; `storage` is declared but no plan bills it. */
const testCatalog = Effect.runSync(
  catalog({
    features: [messages, requests, storage, seats, support],
    tiers: [
      tier({
        id: "support",
        group: "support",
        addOn: true,
        grants: [allowance(support, { included: 5 })],
      }),
      tier({
        id: "team",
        grants: [
          allowance(messages, { included: 100 }),
          allowance(requests, {
            included: 0,
            overage: "bill",
            unitPrice: { amount: 2, currency: "usd" },
          }),
          allowance(seats, { included: 1 }),
        ],
      }),
    ],
  }),
);

const account = "acct_controls" as AccountId;

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
  BillingApiLayer,
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

const subscribe = (accountId: AccountId) =>
  Effect.gen(function* () {
    const subscribe = yield* subscribeOperation();

    yield* subscribe({ account: accountId, tier: "team" });
  });

describe("customers", () => {
  both("answers a customer that has not bought anything", () =>
    Effect.gen(function* () {
      const customers = yield* Customers(account);

      const customer = yield* customers.get();

      expect(customer.id).toBe(account);
      expect(customer.plans).toEqual([]);
      expect(customer.billingControls).toBeUndefined();
    }),
  );

  both("writes controls before a plan exists, and reads them back", () =>
    Effect.gen(function* () {
      const customers = yield* Customers(account);

      const written = yield* customers.update({
        billingControls: {
          spendLimits: [{ featureId: "requests", amount: 5_000 }],
          usageAlerts: [{ featureId: "requests", at: 1_000 }],
        },
      });

      expect(written.billingControls?.spendLimits).toEqual([
        { featureId: "requests", amount: 5_000 },
      ]);

      const read = yield* customers.get();
      expect(read.billingControls).toEqual(written.billingControls);
    }),
  );

  both("reads the plan and the controls together after activation", () =>
    Effect.gen(function* () {
      yield* subscribe(account);
      const customers = yield* Customers(account);

      yield* customers.update({
        billingControls: { autoTopUp: { enabled: true, threshold: 500 } },
      });

      const customer = yield* customers.get();

      expect(customer.plans).toEqual([{ planId: "team", version: 1, status: "active" }]);
      expect(customer.billingControls?.autoTopUp).toEqual({ enabled: true, threshold: 500 });
    }),
  );

  both("clears every control with an empty object", () =>
    Effect.gen(function* () {
      yield* subscribe(account);
      const customers = yield* Customers(account);

      yield* customers.update({
        billingControls: { spendLimits: [{ featureId: "requests", amount: 5_000 }] },
      });

      const cleared = yield* customers.update({ billingControls: {} });

      expect(cleared.billingControls).toBeUndefined();
      expect((yield* customers.get()).billingControls).toBeUndefined();
    }),
  );

  both("refuses a control for a feature the catalog does not declare", () =>
    Effect.gen(function* () {
      const customers = yield* Customers(account);

      const refused = yield* Effect.flip(
        customers.update({ billingControls: { usageAlerts: [{ featureId: "nope", at: 1 }] } }),
      );

      expect(refused._tag).toBe("ControlsFeatureUnknown");
    }),
  );

  both("refuses a spend limit on a feature no plan prices", () =>
    Effect.gen(function* () {
      const customers = yield* Customers(account);

      const refused = yield* Effect.flip(
        customers.update({
          billingControls: { spendLimits: [{ featureId: "storage", amount: 100 }] },
        }),
      );

      expect(refused._tag).toBe("ControlsFeatureNotPriced");
    }),
  );

  both("refuses two limits for one feature", () =>
    Effect.gen(function* () {
      const customers = yield* Customers(account);

      const refused = yield* Effect.flip(
        customers.update({
          billingControls: {
            spendLimits: [
              { featureId: "requests", amount: 100 },
              { featureId: "requests", amount: 200 },
            ],
          },
        }),
      );

      expect(refused._tag).toBe("ControlsDuplicate");
    }),
  );

  both("refuses a spend past the customer's ceiling, and leaves the standing good", () =>
    Effect.gen(function* () {
      yield* subscribe(account);
      const customers = yield* Customers(account);
      const track = yield* TrackUsage(account);

      yield* customers.update({
        billingControls: { spendLimits: [{ featureId: "requests", amount: 0 }] },
      });

      const refused = yield* Effect.flip(
        track({ featureId: "requests", value: 1, idempotencyKey: "past-the-limit" }),
      );

      expect(refused._tag).toBe("SpendLimitExceeded");
      expect((yield* customers.get()).plans[0]?.status).toBe("active");
    }),
  );

  both("reports the ceiling's headroom on a balance, and refuses the check past it", () =>
    Effect.gen(function* () {
      yield* subscribe(account);
      const customers = yield* Customers(account);
      const check = yield* Check(account);

      yield* customers.update({
        billingControls: { spendLimits: [{ featureId: "requests", amount: 10 }] },
      });

      const answer = yield* check({ featureId: "requests", requiredBalance: 1 });

      expect(answer.balance.spendLimit).toEqual({ amount: 10, remaining: 10 });
      expect(answer.allowed).toBe(true);

      const past = yield* check({ featureId: "requests", requiredBalance: 6 });

      expect(past.allowed).toBe(false);
      expect(past.balance.spendLimit?.remaining).toBe(10);
    }),
  );

  both("records an alert once, and only for a spend that records", () =>
    Effect.gen(function* () {
      yield* subscribe(account);
      const customers = yield* Customers(account);
      const track = yield* TrackUsage(account);
      const billing = yield* BillingState;
      const entitlements = yield* Entitlements;
      const viewOf = () => Effect.map(billing.query(Subscription.ref(account)), Option.getOrNull);

      const usedOf = () =>
        Effect.map(entitlements.query(Subscription.ref(account)), Option.getOrNull);

      yield* customers.update({
        billingControls: { usageAlerts: [{ featureId: "requests", at: 2 }] },
      });

      yield* track({ featureId: "requests", value: 2, idempotencyKey: "alert-2" });
      const first = yield* viewOf();

      expect(first?.alertsFired?.map((alert) => alert.at)).toEqual([2]);

      // A second fact past the same threshold does not fire it again.
      yield* track({ featureId: "requests", value: 1, idempotencyKey: "alert-3" });
      const second = yield* viewOf();

      expect(second?.alertsFired?.length).toBe(1);
      expect((yield* usedOf())?.features.requests?.used).toBe(3);
    }),
  );
});

it.live("records a controls write once when the same object is sent twice", () =>
  Effect.gen(function* () {
    yield* subscribe(account);
    const subscription = yield* Subscription;

    const command = new SetBillingControlsCommand({
      billingControls: { spendLimits: [{ featureId: "requests", amount: 10 }] },
      features: { requests: { priced: true } },
    });

    const first = yield* asSystem(subscription.send(Subscription.ref(account), command));
    const second = yield* asSystem(subscription.send(Subscription.ref(account), command));

    expect(first.events.map((event) => event._tag)).toEqual(["BillingControlsSet"]);
    expect(second.events).toEqual([]);
  }).pipe(Effect.provide(inProcessWorld)),
);

both("refuses a hold past the customer's ceiling", () =>
  Effect.gen(function* () {
    yield* subscribe(account);
    const customers = yield* Customers(account);
    const hold = yield* Hold(account);

    yield* customers.update({
      billingControls: { spendLimits: [{ featureId: "requests", amount: 0 }] },
    });

    const refused = yield* Effect.flip(
      hold({ feature: "requests", amount: 1, dedupeKey: "hold-over" }),
    );

    expect(refused._tag).toBe("SpendLimitExceeded");
  }),
);

both("accepts a ceiling below the period's bill and binds the next spend", () =>
  Effect.gen(function* () {
    yield* subscribe(account);
    const customers = yield* Customers(account);
    const track = yield* TrackUsage(account);
    const balances = yield* Balances(account);

    yield* customers.update({
      billingControls: { spendLimits: [{ featureId: "requests", amount: 10 }] },
    });
    yield* track({ featureId: "requests", value: 5, idempotencyKey: "bill-10" });

    // The money is already billed; lowering the ceiling is accepted and
    // stops the next spend. It never unbills history.
    yield* customers.update({
      billingControls: { spendLimits: [{ featureId: "requests", amount: 4 }] },
    });

    const refused = yield* Effect.flip(
      track({ featureId: "requests", value: 1, idempotencyKey: "past-lowered" }),
    );

    expect(refused._tag).toBe("SpendLimitExceeded");

    const balance = yield* balances.get({ featureId: "requests" });

    expect(balance.spendLimit).toEqual({ amount: 4, remaining: 0 });
  }),
);

it.live("lists every active plan, not only the base one", () =>
  Effect.gen(function* () {
    yield* subscribe(account);
    const customers = yield* Customers(account);
    const attach = yield* Attach(account);

    yield* attach({ planId: "support", idempotencyKey: "add-support" });

    // `Attach` commits the command; the billing view catches up behind it.
    const billing = yield* BillingState;
    yield* billing.query(Subscription.ref(account)).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        times: 100,
        until: (view) => Option.getOrNull(view)?.plans.support !== undefined,
      }),
    );

    const customer = yield* customers.get();

    expect(customer.plans.map((plan) => plan.planId).sort()).toEqual(["support", "team"]);
    expect(
      customer.plans.find((plan) => plan.planId === "support")?.scheduledPlanId,
    ).toBeUndefined();
  }).pipe(Effect.provide(inProcessWorld)),
);
