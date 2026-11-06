import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { PaymentDeclined, Payments, ProviderCapabilityMissing } from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { PaymentsPolar, type PolarBindings } from "../../src/PaymentsPolar.ts";
import { PaymentsStripe } from "../../src/PaymentsStripe.ts";
import type { StripeBindings } from "../../src/PaymentsStripe.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };

const stripeFixture: StripeBindings = {
  createCheckoutSession: ({ priceIds }) =>
    Effect.succeed({ url: `https://stripe.test/checkout/${priceIds.join(",")}` }),
  createCustomerSession: ({ account }) =>
    Effect.succeed({ url: `https://stripe.test/portal/${account}` }),
  createRefund: () => Effect.succeed({ refundId: "re_test" }),
};

const polarBindings: PolarBindings = {
  createCheckoutSession: ({ productId }) =>
    Effect.succeed({ url: `https://polar.test/checkout/${productId}` }),
  createCustomerSession: ({ account }) =>
    Effect.succeed({ url: `https://polar.test/portal/${account}` }),
  createRefund: () => Effect.succeed({ refundId: "re_polar" }),
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
            kind: "subscription",
          });
          return checkout.url;
        }),
      );
      expect(url).toBe("https://stripe.test/checkout/price_1");
      expect(provider.prices).toEqual({ pro: price });
    }),
  );

  it.effect("Stripe and Polar pass a one-off kind through to the purchase", () =>
    Effect.gen(function* () {
      const asked: Array<{ readonly kind: string }> = [];
      const stripe = PaymentsStripe({
        bindings: {
          ...stripeFixture,
          createCheckoutSession: ({ priceIds, kind }) => {
            asked.push({ kind });
            return Effect.succeed({ url: `https://stripe.test/checkout/${priceIds.join(",")}` });
          },
        },
        tiers: { credits: { price, priceId: "price_pack" } },
      });
      yield* withProvider(
        stripe,
        Effect.gen(function* () {
          yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "credits",
            kind: "one_off",
          });
        }),
      );
      expect(asked).toEqual([{ kind: "one_off" }]);
    }),
  );

  it.effect("Stripe refuses a tier with no configured price", () =>
    Effect.gen(function* () {
      const provider = PaymentsStripe({ bindings: stripeFixture });
      const error = yield* Effect.flip(
        withProvider(
          provider,
          Effect.gen(function* () {
            return yield* (yield* Payments).createCheckout({
              account: "acct_1",
              tier: "pro",
              kind: "subscription",
            });
          }),
        ),
      );
      expect(error).toBeInstanceOf(PaymentDeclined);
      if (error._tag === "PaymentDeclined") {
        expect(error.code).toBe("price_not_configured");
      }
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
            kind: "subscription",
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
            return yield* (yield* Payments).createCheckout({
              account: "acct_1",
              tier: "pro",
              kind: "subscription",
            });
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
      for (const op of ["createCheckout", "createPortal"] as const) {
        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const payments = yield* Payments;
            if (op === "createCheckout") {
              return yield* payments.createCheckout({
                account: "acct_1",
                tier: "pro",
                kind: "subscription",
              });
            }
            return yield* payments.createPortal({ account: "acct_1" });
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

describe("the usage adapter", () => {
  const unitPrice = { amount: 2, currency: "usd" } as const;

  it.effect("Stripe attaches the metered price and reports the period's units", () =>
    Effect.gen(function* () {
      const asked: Array<{
        account: string;
        lines: ReadonlyArray<{ feature: string; quantity: number }>;
        commandId: string;
      }> = [];
      const provider = PaymentsStripe({
        bindings: {
          ...stripeFixture,
          reportUsage: (args) =>
            Effect.sync(() => {
              asked.push(args);
              return {};
            }),
        },
        tiers: {
          pro: {
            price,
            priceId: "price_1",
            usage: { messages: { unitPrice, priceId: "price_msg" } },
          },
        },
      });

      expect(provider.capabilities.has("usage")).toBe(true);
      expect(provider.unitPrices).toEqual({ pro: { messages: unitPrice } });

      const url = yield* withProvider(
        provider,
        Effect.gen(function* () {
          const checkout = yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
            kind: "subscription",
          });
          return checkout.url;
        }),
      );
      // The base price and the metered price are line items on one subscription.
      expect(url).toBe("https://stripe.test/checkout/price_1,price_msg");

      const periodStart = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
      const periodEnd = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
      yield* withProvider(
        provider,
        Effect.gen(function* () {
          yield* (yield* Payments).reportUsage({
            account: "acct_1",
            periodStart,
            periodEnd,
            lines: [{ feature: "messages", unitPrice, quantity: 50 }],
            commandId: "period-usage:1:2",
          });
        }),
      );
      expect(asked).toEqual([
        {
          account: "acct_1",
          periodStart,
          periodEnd,
          lines: [{ feature: "messages", unitPrice, quantity: 50 }],
          commandId: "period-usage:1:2",
        },
      ]);
    }),
  );

  it.effect("Polar maps a tier's usage prices, and reportUsage reaches the binding", () =>
    Effect.gen(function* () {
      const asked: Array<{ lines: ReadonlyArray<{ feature: string; quantity: number }> }> = [];
      const provider = PaymentsPolar({
        bindings: {
          ...polarBindings,
          reportUsage: (args) =>
            Effect.sync(() => {
              asked.push(args);
              return {};
            }),
        },
        tiers: { pro: { price, productId: "prod_1", usage: { messages: unitPrice } } },
      });

      expect(provider.capabilities.has("usage")).toBe(true);
      expect(provider.unitPrices).toEqual({ pro: { messages: unitPrice } });

      const url = yield* withProvider(
        provider,
        Effect.gen(function* () {
          const checkout = yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
            kind: "subscription",
          });
          return checkout.url;
        }),
      );
      expect(url).toBe("https://polar.test/checkout/prod_1");

      yield* withProvider(
        provider,
        Effect.gen(function* () {
          yield* (yield* Payments).reportUsage({
            account: "acct_1",
            periodStart: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
            periodEnd: DateTime.makeUnsafe("2030-02-01T00:00:00Z"),
            lines: [{ feature: "messages", unitPrice, quantity: 50 }],
            commandId: "period-usage:1:2",
          });
        }),
      );
      expect(asked[0]).toMatchObject({
        lines: [{ feature: "messages", unitPrice, quantity: 50 }],
      });
    }),
  );

  it.effect("Stripe maps a ladder to the full usage pricing", () =>
    Effect.gen(function* () {
      const ladder = {
        _tag: "graduated" as const,
        currency: "usd",
        bands: [
          { upTo: 100, unitPrice: { amount: 1, currency: "usd" } },
          { upTo: "inf" as const, unitPrice: { amount: 2, currency: "usd" } },
        ] as const,
      };
      const provider = PaymentsStripe({
        bindings: stripeFixture,
        tiers: {
          pro: {
            price,
            priceId: "price_1",
            usage: { messages: { pricing: ladder, priceId: "price_msg" } },
          },
        },
      });

      expect(provider.usagePrices).toEqual({ pro: { messages: ladder } });
      // A ladder has no one rate, so there is nothing for the shorthand to say.
      expect(provider.unitPrices).toBe(undefined);

      const url = yield* withProvider(
        provider,
        Effect.gen(function* () {
          const checkout = yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
            kind: "subscription",
          });
          return checkout.url;
        }),
      );
      expect(url).toBe("https://stripe.test/checkout/price_1,price_msg");
    }),
  );

  it.effect("Polar maps a package to both the full pricing and its one rate", () =>
    Effect.gen(function* () {
      const packagePricing = {
        _tag: "unit" as const,
        unitPrice: { amount: 500, currency: "usd", units: 1_000 },
      };
      const provider = PaymentsPolar({
        bindings: polarBindings,
        tiers: { pro: { price, productId: "prod_1", usage: { messages: packagePricing } } },
      });

      expect(provider.usagePrices).toEqual({ pro: { messages: packagePricing } });
      expect(provider.unitPrices).toEqual({
        pro: { messages: { amount: 500, currency: "usd", units: 1_000 } },
      });
    }),
  );

  it.effect("a provider without a reporter refuses with a typed missing capability", () =>
    Effect.gen(function* () {
      const provider = PaymentsStripe({
        bindings: stripeFixture,
        tiers: { pro: { price, priceId: "price_1" } },
      });
      const error = yield* Effect.flip(
        withProvider(
          provider,
          Effect.gen(function* () {
            yield* (yield* Payments).reportUsage({
              account: "acct_1",
              periodStart: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
              periodEnd: DateTime.makeUnsafe("2030-02-01T00:00:00Z"),
              lines: [{ feature: "messages", unitPrice, quantity: 50 }],
              commandId: "period-usage:1:2",
            });
          }),
        ),
      );
      expect(error).toBeInstanceOf(ProviderCapabilityMissing);
      if (error._tag === "ProviderCapabilityMissing") expect(error.op).toBe("reportUsage");
    }),
  );
});

describe("the Stripe adapter", () => {
  const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

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
