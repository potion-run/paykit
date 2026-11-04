import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { PaymentDeclined, Payments, ProviderCapabilityMissing } from "../../src/Payments.ts";
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

const withProvider = <A, E, R>(
  provider: ReturnType<typeof PaymentsStripe> | ReturnType<typeof PaymentsPolar>,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.provide(provider.payments)) as Effect.Effect<A, E, never>;

describe("provider adapters", () => {
  it.effect("Stripe passes the mapped price id to the checkout session", () =>
    Effect.gen(function* () {
      const provider = PaymentsStripe({
        bindings: stripeBindings,
        tiers: { pro: { price, priceId: "price_1" } },
      });
      const url = yield* withProvider(
        provider,
        Effect.gen(function* () {
          const checkout = yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
          });
          return checkout.url;
        }),
      );
      expect(url).toBe("https://stripe.test/checkout/price_1");
      expect(provider.prices).toEqual({ pro: price });
      expect(provider.capabilities.has("syncTier")).toBe(false);
    }),
  );

  it.effect("Stripe refuses a tier with no configured price", () =>
    Effect.gen(function* () {
      const provider = PaymentsStripe({ bindings: stripeBindings });
      const error = yield* Effect.flip(
        withProvider(
          provider,
          Effect.gen(function* () {
            return yield* (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" });
          }),
        ),
      );
      expect(error).toBeInstanceOf(PaymentDeclined);
      if (error._tag === "PaymentDeclined") {
        expect(error.code).toBe("price_not_configured");
      }
    }),
  );

  it.effect("Stripe declares syncTier only when the binding exists", () =>
    Effect.gen(function* () {
      const withSync = PaymentsStripe({
        bindings: { ...stripeBindings, syncTier: () => Effect.succeed({}) },
        tiers: { pro: { price, priceId: "price_1" } },
      });
      expect(withSync.capabilities.has("syncTier")).toBe(true);
      const error = yield* Effect.flip(
        withProvider(
          PaymentsStripe({ bindings: stripeBindings }),
          Effect.gen(function* () {
            return yield* (yield* Payments).syncTier({ account: "acct_1", tier: "pro" });
          }),
        ),
      );
      expect(error).toBeInstanceOf(ProviderCapabilityMissing);
    }),
  );

  it.effect("Polar passes the mapped product id and refuses a missing one", () =>
    Effect.gen(function* () {
      const provider = PaymentsPolar({
        bindings: polarBindings,
        tiers: { pro: { price, productId: "prod_1" } },
      });
      const url = yield* withProvider(
        provider,
        Effect.gen(function* () {
          const checkout = yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
          });
          return checkout.url;
        }),
      );
      expect(url).toBe("https://polar.test/checkout/prod_1");
      expect(provider.kind).toBe("merchant_of_record");
      expect(provider.prices).toEqual({ pro: price });

      const missing = yield* Effect.flip(
        withProvider(
          PaymentsPolar({ bindings: polarBindings }),
          Effect.gen(function* () {
            return yield* (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" });
          }),
        ),
      );
      expect(missing).toBeInstanceOf(PaymentDeclined);
    }),
  );

  it.effect("Manual sells an invoice and refuses every op it does not own", () =>
    Effect.gen(function* () {
      const manual = PaymentsManual();
      const result = yield* Effect.gen(function* () {
        const payments = yield* Payments;
        const first = yield* payments.createInvoice({
          account: "acct_1",
          amount: 1900,
          currency: "usd",
        });
        const second = yield* payments.createInvoice({
          account: "acct_1",
          amount: 1900,
          currency: "usd",
        });
        return [first.invoiceId, second.invoiceId] as const;
      }).pipe(Effect.provide(manual.payments)) as Effect.Effect<
        readonly [string, string],
        never,
        never
      >;
      expect(result).toEqual(["manual_invoice_1", "manual_invoice_2"]);
      for (const op of ["createCheckout", "createPortal", "syncTier"] as const) {
        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const payments = yield* Payments;
            if (op === "createCheckout") {
              return yield* payments.createCheckout({ account: "acct_1", tier: "pro" });
            }
            if (op === "createPortal") {
              return yield* payments.createPortal({ account: "acct_1" });
            }
            return yield* payments.syncTier({ account: "acct_1", tier: "pro" });
          }).pipe(Effect.provide(manual.payments)) as Effect.Effect<never, unknown, never>,
        );
        expect(error).toBeInstanceOf(ProviderCapabilityMissing);
      }
    }),
  );

  it.effect("Memory refuses an invoice with no positive amount", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          return yield* (yield* Payments).createInvoice({
            account: "acct_1",
            amount: 0,
            currency: "usd",
          });
        }).pipe(Effect.provide(PaymentsMemory().payments)) as Effect.Effect<
          unknown,
          unknown,
          never
        >,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("PaymentDeclined");
    }),
  );
});
