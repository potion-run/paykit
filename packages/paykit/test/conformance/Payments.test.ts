import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Payments, type MoneyProvider } from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { PaymentsPolar, type PolarBindings } from "../../src/PaymentsPolar.ts";
import { PaymentsStripe, type StripeBindings } from "../../src/PaymentsStripe.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };

const stripeBindings: StripeBindings = {
  createCheckoutSession: ({ priceId }) =>
    Effect.succeed({ url: `https://stripe.test/checkout/${priceId}` }),
  createCustomerSession: ({ account }) =>
    Effect.succeed({ url: `https://stripe.test/portal/${account}` }),
  createRefund: () => Effect.succeed({}),
};

const polarBindings: PolarBindings = {
  createCheckoutSession: ({ productId }) =>
    Effect.succeed({ url: `https://polar.test/checkout/${productId}` }),
  createCustomerSession: ({ account }) =>
    Effect.succeed({ url: `https://polar.test/portal/${account}` }),
  createRefund: () => Effect.succeed({}),
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
              (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" }),
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
        "refund succeeds or is missing as declared",
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              (yield* Payments).refund({ chargeId: "ch_1", amount: 100 }),
            );
            expect(Exit.isSuccess(exit)).toBe(provider.capabilities.has("refund"));
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
    });
  }

  it("Manual is the reference: it sells through an invoice and refunds", () => {
    const manual = PaymentsManual();
    expect(manual.capabilities.has("invoice")).toBe(true);
    expect(manual.capabilities.has("refund")).toBe(true);
    expect(manual.capabilities.has("checkout")).toBe(false);
  });

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
  });

  it.effect(
    "a provider without a configured price refuses the sale",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          (yield* Payments).createCheckout({ account: "acct_1", tier: "missing" }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("PaymentDeclined");
      }).pipe(
        Effect.provide(PaymentsStripe({ bindings: stripeBindings }).payments),
      ) as Effect.Effect<void, never, never>,
  );
});
