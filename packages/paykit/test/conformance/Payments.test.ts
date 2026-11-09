import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { SetupPayment as SetupPaymentBinding } from "../../src/Billing/SetupPayment.binding.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import {
  Payments,
  ProviderCapabilityMissing,
  paymentsRouter,
  type MoneyProvider,
} from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { PaymentsPolar, type PolarBindings } from "../../src/PaymentsPolar.ts";
import { PaymentsStripe, type StripeBindings } from "../../src/PaymentsStripe.ts";
import { AttachProviderRef } from "../../src/Subscription/AttachProviderRef.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };

const stripeBindings: StripeBindings = {
  createCheckoutSession: ({ priceIds }) =>
    Effect.succeed({ url: `https://stripe.test/checkout/${priceIds.join(",")}` }),
  createCustomerSession: ({ account }) =>
    Effect.succeed({ url: `https://stripe.test/portal/${account}` }),
  createSetupSession: ({ account }) =>
    Effect.succeed({ url: `https://stripe.test/setup/${account}` }),
  createRefund: () => Effect.succeed({ refundId: "re_test" }),
  charge: ({ account }) => Effect.succeed({ chargeId: `ch_${account}` }),
};

const polarBindings: PolarBindings = {
  createCheckoutSession: ({ productId }) =>
    Effect.succeed({ url: `https://polar.test/checkout/${productId}` }),
  createCustomerSession: ({ account }) =>
    Effect.succeed({ url: `https://polar.test/portal/${account}` }),
  createSetupSession: ({ account }) =>
    Effect.succeed({ url: `https://polar.test/setup/${account}` }),
  createRefund: () => Effect.succeed({ refundId: "re_polar" }),
};

const providers: ReadonlyArray<readonly [string, MoneyProvider]> = [
  ["Memory", PaymentsMemory()],
  ["Manual", PaymentsManual()],
  [
    "Stripe",
    PaymentsStripe({ bindings: stripeBindings, tiers: { pro: { price, priceId: "price_1" } } }),
  ],
  [
    "Polar",
    PaymentsPolar({ bindings: polarBindings, tiers: { pro: { price, productId: "prod_1" } } }),
  ],
];

const operationCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [tier({ id: "pro", price, grants: [allowance(messages, { included: 100 })] })],
  }),
);

const OperationModel = PaykitModel.layer(PaykitHandlers).pipe(
  Layer.provideMerge(MemoryBillingReadStore),
  Layer.provide(Domain.InMemory),
  Layer.provideMerge(Layer.succeed(Actor, system("test"))),
  Layer.provideMerge(catalogLayer(operationCatalog)),
);

const OperationProviders = paymentsRouter(
  PaymentsStripe({ bindings: stripeBindings, tiers: { pro: { price, priceId: "price_1" } } }),
  PaymentsManual(),
);

const OperationWorld = Layer.mergeAll(
  OperationModel,
  BillingInProcess.pipe(Layer.provide(OperationModel), Layer.provide(OperationProviders)),
  catalogLayer(operationCatalog),
  OperationProviders,
);

describe("Payments conformance", () => {
  for (const [name, provider] of providers) {
    describe(name, () => {
      it("declares at least one purchase path", () => {
        expect(provider.capabilities.has("checkout") || provider.capabilities.has("invoice")).toBe(
          true,
        );
      });

      it.effect(
        "createCheckout succeeds or is missing as declared",
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              (yield* Payments).createCheckout({
                account: "acct_1",
                tier: "pro",
                kind: "subscription",
              }),
            );

            if (provider.capabilities.has("checkout")) {
              expect(Exit.isSuccess(exit)).toBe(true);

              if (Exit.isSuccess(exit)) expect(exit.value.url.length).toBeGreaterThan(0);
            } else {
              expect(Exit.isFailure(exit)).toBe(true);

              if (Exit.isFailure(exit)) {
                expect(String(exit.cause)).toContain("ProviderCapabilityMissing");
              }
            }
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );

      it.effect(
        "createInvoice succeeds or is missing as declared",
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              (yield* Payments).createInvoice({ account: "acct_1", amount: 1900, currency: "usd" }),
            );

            if (provider.capabilities.has("invoice")) {
              expect(Exit.isSuccess(exit)).toBe(true);

              if (Exit.isSuccess(exit)) expect(exit.value.invoiceId.length).toBeGreaterThan(0);
            } else {
              expect(Exit.isFailure(exit)).toBe(true);
            }
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );

      it.effect(
        "reuses the invoice a command id already opened",
        () =>
          Effect.gen(function* () {
            if (!provider.capabilities.has("invoice")) return;
            const payments = yield* Payments;

            const request = {
              account: "acct_1",
              amount: 1900,
              currency: "usd",
              commandId: "same-change",
            } as const;

            const first = yield* payments.createInvoice(request);
            const second = yield* payments.createInvoice(request);
            expect(second.invoiceId).toBe(first.invoiceId);
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );

      it.effect(
        "charge succeeds or is missing as declared",
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              (yield* Payments).charge({ account: "acct_1", amount: 1900, currency: "usd" }),
            );

            expect(Exit.isSuccess(exit)).toBe(provider.capabilities.has("charge"));

            if (provider.capabilities.has("charge") && Exit.isSuccess(exit)) {
              expect(exit.value.chargeId.length).toBeGreaterThan(0);
            }

            if (!provider.capabilities.has("charge") && Exit.isFailure(exit)) {
              expect(String(exit.cause)).toContain("ProviderCapabilityMissing");
            }
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );

      it.effect(
        "reuses the charge a command id already took",
        () =>
          Effect.gen(function* () {
            if (!provider.capabilities.has("charge")) return;
            const payments = yield* Payments;

            const request = {
              account: "acct_1",
              amount: 1900,
              currency: "usd",
              commandId: "same-crossing",
            } as const;

            const first = yield* payments.charge(request);
            const second = yield* payments.charge(request);
            expect(second.chargeId).toBe(first.chargeId);
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );

      it.effect(
        "refund succeeds or is missing as declared, and answers the provider's id",
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              (yield* Payments).refund({ chargeId: "ch_1", amount: 100 }),
            );

            expect(Exit.isSuccess(exit)).toBe(provider.capabilities.has("refund"));

            if (Exit.isSuccess(exit)) {
              expect(exit.value.refundId.length).toBeGreaterThan(0);
            }
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );

      it.effect(
        "reportUsage succeeds or is missing as declared",
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              (yield* Payments).reportUsage({
                account: "acct_1",
                periodStart: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
                periodEnd: DateTime.makeUnsafe("2030-02-01T00:00:00Z"),
                lines: [
                  { feature: "messages", unitPrice: { amount: 2, currency: "usd" }, quantity: 50 },
                ],
                commandId: "period-usage:1:2",
              }),
            );

            expect(Exit.isSuccess(exit)).toBe(provider.capabilities.has("usage"));

            if (!provider.capabilities.has("usage") && Exit.isFailure(exit)) {
              expect(String(exit.cause)).toContain("ProviderCapabilityMissing");
            }
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );

      it.effect(
        "createPortal succeeds or is missing as declared",
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit((yield* Payments).createPortal({ account: "acct_1" }));
            expect(Exit.isSuccess(exit)).toBe(provider.capabilities.has("portal"));

            if (!provider.capabilities.has("portal") && Exit.isFailure(exit)) {
              expect(String(exit.cause)).toContain("ProviderCapabilityMissing");
            }
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );

      it.effect(
        "setupPayment succeeds or is missing as declared",
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              (yield* Payments).setupPayment({ account: "acct_1", commandId: "setup:1" }),
            );

            expect(Exit.isSuccess(exit)).toBe(provider.capabilities.has("setup"));

            if (provider.capabilities.has("setup") && Exit.isSuccess(exit)) {
              expect(exit.value.url.length).toBeGreaterThan(0);
            }

            if (!provider.capabilities.has("setup") && Exit.isFailure(exit)) {
              expect(String(exit.cause)).toContain("ProviderCapabilityMissing");
            }
          }).pipe(Effect.provide(provider.payments)) as Effect.Effect<void, never, never>,
      );
    });
  }

  it.effect("passes the setup command id to each provider's binding", () =>
    Effect.gen(function* () {
      const stripeAsked: Array<string | undefined> = [];
      const polarAsked: Array<string | undefined> = [];

      const stripe = PaymentsStripe({
        bindings: {
          ...stripeBindings,
          createSetupSession: ({ commandId }) => {
            stripeAsked.push(commandId);

            return Effect.succeed({ url: "https://stripe.test/setup" });
          },
        },
      });

      const polar = PaymentsPolar({
        bindings: {
          ...polarBindings,
          createSetupSession: ({ commandId }) => {
            polarAsked.push(commandId);

            return Effect.succeed({ url: "https://polar.test/setup" });
          },
        },
      });

      for (const provider of [stripe, polar]) {
        yield* Effect.gen(function* () {
          yield* (yield* Payments).setupPayment({
            account: "acct_1",
            commandId: "setup:retry",
          });
        }).pipe(Effect.provide(provider.payments));
      }

      expect(stripeAsked).toEqual(["setup:retry"]);
      expect(polarAsked).toEqual(["setup:retry"]);
    }),
  );

  it.live("the setup operation routes to the provider the account pays through", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;

      yield* subscription.send(
        Subscription.ref("acct_setup_stripe"),
        new AttachProviderRef({ provider: "stripe", refs: { customer: "cus_1" } }),
      );

      const setup = yield* SetupPaymentBinding("acct_setup_stripe");
      expect((yield* setup()).url).toBe("https://stripe.test/setup/acct_setup_stripe");

      yield* subscription.send(
        Subscription.ref("acct_setup_manual"),
        new AttachProviderRef({ provider: "manual", refs: { customer: "cus_1" } }),
      );

      const manualSetup = yield* SetupPaymentBinding("acct_setup_manual");
      const refused = yield* Effect.flip(manualSetup());

      expect(refused).toBeInstanceOf(ProviderCapabilityMissing);

      if (refused._tag === "ProviderCapabilityMissing") {
        expect(refused.provider).toBe("manual");
        expect(refused.op).toBe("setupPayment");
      }
    }).pipe(Effect.provide(OperationWorld)),
  );

  it("Manual is the reference: it sells through an invoice and refunds", () => {
    const manual = PaymentsManual();
    expect(manual.capabilities.has("invoice")).toBe(true);
    expect(manual.capabilities.has("refund")).toBe(true);
    expect(manual.capabilities.has("checkout")).toBe(false);
  });

  it.effect("Memory meters a period once, even when the same close is replayed", () =>
    Effect.gen(function* () {
      const memory = PaymentsMemory();

      const args = {
        account: "acct_1",
        periodStart: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
        periodEnd: DateTime.makeUnsafe("2030-02-01T00:00:00Z"),
        lines: [
          { feature: "messages", unitPrice: { amount: 2, currency: "usd" }, quantity: 50 },
          { feature: "seats", unitPrice: { amount: 500, currency: "usd" }, quantity: 2 },
        ],
        commandId: "period-usage:1:2",
      } as const;

      yield* Effect.gen(function* () {
        const payments = yield* Payments;
        yield* payments.reportUsage(args);
        yield* payments.reportUsage(args);
      }).pipe(Effect.provide(memory.payments));
      expect(memory.reports).toEqual([args]);
    }),
  );

  it("Stripe and Polar each declare the optional ops they implement", () => {
    const stripe = PaymentsStripe({
      bindings: stripeBindings,
      tiers: { pro: { price, priceId: "price_1" } },
    });

    const polar = PaymentsPolar({
      bindings: polarBindings,
      tiers: { pro: { price, productId: "prod_1" } },
    });

    expect(stripe.kind).toBe("processor");
    expect(polar.kind).toBe("merchant_of_record");
    // Neither fixture supplies an invoice binding, so neither declares one.
    expect(stripe.capabilities.has("invoice")).toBe(false);
    expect(polar.capabilities.has("invoice")).toBe(false);
    expect(stripe.capabilities.has("portal")).toBe(true);
    // Neither fixture supplies a reporter, so neither declares `usage`.
    expect(stripe.capabilities.has("usage")).toBe(false);
    expect(polar.capabilities.has("usage")).toBe(false);

    const reporting = PaymentsStripe({
      bindings: { ...stripeBindings, reportUsage: () => Effect.succeed({}) },
      tiers: { pro: { price, priceId: "price_1" } },
    });

    const metering = PaymentsPolar({
      bindings: { ...polarBindings, reportUsage: () => Effect.succeed({}) },
      tiers: { pro: { price, productId: "prod_1" } },
    });

    expect(reporting.capabilities.has("usage")).toBe(true);
    expect(metering.capabilities.has("usage")).toBe(true);
  });

  it.effect(
    "a provider without a configured price refuses the sale",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "missing",
            kind: "subscription",
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("PaymentDeclined");
      }).pipe(
        Effect.provide(PaymentsStripe({ bindings: stripeBindings }).payments),
      ) as Effect.Effect<void, never, never>,
  );
});
