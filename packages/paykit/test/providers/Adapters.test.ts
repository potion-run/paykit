import { describe, expect, it } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { PaymentDeclined, Payments, ProviderCapabilityMissing } from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { PaymentsPolar, type PolarBindings } from "../../src/PaymentsPolar.ts";
import { PaymentsStripe, stripeBindings } from "../../src/PaymentsStripe.ts";
import type { StripeBindings } from "../../src/PaymentsStripe.ts";

/** What a vendor SDK raises: tagged, so it never enters a failure channel as `unknown`. */
class StripeVendorFailure extends Data.TaggedError("StripeVendorFailure")<{
  readonly message: string;
}> {}

const price = { amount: 1900, currency: "usd", interval: "month" as const };

const stripeFixture: StripeBindings = {
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
        bindings: stripeFixture,
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
      const provider = PaymentsStripe({ bindings: stripeFixture });
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
        bindings: { ...stripeFixture, syncTier: () => Effect.succeed({}) },
        tiers: { pro: { price, priceId: "price_1" } },
      });
      expect(withSync.capabilities.has("syncTier")).toBe(true);
      const error = yield* Effect.flip(
        withProvider(
          PaymentsStripe({ bindings: stripeFixture }),
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

describe("the Stripe adapter", () => {
  const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

  it.effect("maps the account's two Alchemy bindings onto the port", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const adapter = stripeBindings(
        {
          createCheckoutSession: (request) =>
            Effect.sync(() => {
              asked.push(request as never);
              return { url: "https://checkout.stripe.com/c/pay/cs_test" };
            }),
          createBillingPortalSession: (request) =>
            Effect.sync(() => {
              asked.push(request as never);
              return { url: "https://billing.stripe.com/p/session" };
            }),
        },
        { origin: "https://app.example.com" },
      );

      const checkout = yield* adapter.bindings.createCheckoutSession({
        account: "cus_1",
        tier: "pro",
        priceId: "price_1",
      });
      expect(checkout.url).toContain("checkout.stripe.com");
      expect(asked[0]).toMatchObject({
        mode: "subscription",
        line_items: [{ price: "price_1", quantity: 1 }],
        customer: "cus_1",
        success_url: "https://app.example.com/welcome",
        cancel_url: "https://app.example.com/pricing",
      });

      const portal = yield* adapter.bindings.createCustomerSession({ account: "cus_1" });
      expect(portal.url).toContain("billing.stripe.com");
      expect(asked[1]).toMatchObject({
        customer: "cus_1",
        return_url: "https://app.example.com/billing",
      });
    }),
  );

  it.effect("a vendor failure becomes a typed declined payment, not a defect", () =>
    Effect.gen(function* () {
      const adapter = stripeBindings(
        {
          createCheckoutSession: () =>
            Effect.fail(new StripeVendorFailure({ message: "card_declined" })),
          createBillingPortalSession: () =>
            Effect.fail(new StripeVendorFailure({ message: "no such customer" })),
        },
        { origin: "https://app.example.com" },
      );
      const exit = yield* Effect.flip(
        adapter.bindings.createCheckoutSession({
          account: "cus_1",
          tier: "pro",
          priceId: "price_1",
        }),
      );
      expect(exit).toBeInstanceOf(PaymentDeclined);
      expect(exit.message).toContain("card_declined");
    }),
  );

  it.effect("refund is not a capability, because Alchemy ships no refund binding", () =>
    Effect.gen(function* () {
      const adapter = stripeBindings(
        {
          createCheckoutSession: () => Effect.succeed({ url: "u" }),
          createBillingPortalSession: () => Effect.succeed({ url: "u" }),
        },
        { origin: "https://app.example.com" },
      );
      const provider = PaymentsStripe({
        ...adapter,
        tiers: { pro: { price: proPrice, priceId: "price_1" } },
      });
      expect(provider.capabilities.has("refund")).toBe(false);
      expect(provider.capabilities.has("checkout")).toBe(true);
      expect(provider.capabilities.has("portal")).toBe(true);
    }),
  );

  it.effect("an invoice binding is a capability, and the amount reaches the vendor", () =>
    Effect.gen(function* () {
      const asked: Array<{ account: string; amount: number; currency: string }> = [];
      const provider = PaymentsStripe({
        bindings: {
          ...stripeFixture,
          createInvoice: (args) =>
            Effect.sync(() => {
              asked.push(args);
              return { invoiceId: "in_proration" };
            }),
        },
        tiers: { pro: { price: proPrice, priceId: "price_1" } },
      });
      expect(provider.capabilities.has("invoice")).toBe(true);
      const invoice = yield* withProvider(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createInvoice({
            account: "acct_1",
            amount: 8_000,
            currency: "usd",
          });
        }),
      );
      expect(invoice.invoiceId).toBe("in_proration");
      expect(asked).toEqual([{ account: "acct_1", amount: 8_000, currency: "usd" }]);
    }),
  );

  it.effect("Polar declares an invoice only when its bindings carry one", () =>
    Effect.gen(function* () {
      const bare = PaymentsPolar({
        bindings: polarBindings,
        tiers: { pro: { price, productId: "prod_1" } },
      });
      expect(bare.capabilities.has("invoice")).toBe(false);

      const billing = PaymentsPolar({
        bindings: {
          ...polarBindings,
          createInvoice: () => Effect.succeed({ invoiceId: "ord_1" }),
        },
        tiers: { pro: { price, productId: "prod_1" } },
      });
      expect(billing.capabilities.has("invoice")).toBe(true);
      const invoice = yield* withProvider(
        billing,
        Effect.gen(function* () {
          return yield* (yield* Payments).createInvoice({
            account: "acct_1",
            amount: 8_000,
            currency: "usd",
          });
        }),
      );
      expect(invoice.invoiceId).toBe("ord_1");

      const missing = yield* Effect.flip(
        withProvider(
          bare,
          Effect.gen(function* () {
            return yield* (yield* Payments).createInvoice({
              account: "acct_1",
              amount: 8_000,
              currency: "usd",
            });
          }),
        ),
      );
      expect(missing).toBeInstanceOf(ProviderCapabilityMissing);
    }),
  );
});
