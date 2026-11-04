import { describe, expect, it } from "@alchemy.run/test";
import { PaymentDeclined, Payments, ProviderCapabilityMissing } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  STRIPE_API_BASE_URL,
  Stripe,
  distilledStripeClient,
  stripeBaseUrl,
  stripeClientBindings,
  stripePriceOf,
  type StripeClient,
} from "../src/index.ts";

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const tiers = { pro: { price: proPrice, priceId: "price_123" } };

/** A stand-in for Stripe, recording what the package asked for. */
const recording = (asked: Array<Record<string, unknown>> = []): StripeClient => ({
  createCheckoutSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);
      return { url: `https://checkout.stripe.test/${request.priceId}` };
    }),
  createBillingPortalSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);
      return { url: "https://billing.stripe.test/portal" };
    }),
  createInvoice: (request) =>
    Effect.sync(() => {
      asked.push(request as never);
      return { invoiceId: "in_proration" };
    }),
  createRefund: (request) =>
    Effect.sync(() => {
      asked.push(request as never);
      return {};
    }),
});

const runWith = <A, E, R>(provider: ReturnType<typeof Stripe>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(provider.payments)) as Effect.Effect<A, E | PaymentDeclined, never>;

describe("Stripe as a paykit provider", () => {
  it.effect("sells a tier through one checkout, with the price the catalog maps", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers,
        client: recording(asked),
      });
      const session = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" });
        }),
      );
      expect(session.url).toContain("price_123");
      expect(asked[0]).toMatchObject({
        priceId: "price_123",
        tier: "pro",
        customerExternalId: "acct_1",
        successUrl: "https://app.example.com/welcome",
        cancelUrl: "https://app.example.com/pricing",
      });
    }),
  );

  it.effect("opens the customer portal through a billing portal session", () =>
    Effect.gen(function* () {
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers,
        client: recording(),
      });
      const portal = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createPortal({ account: "acct_1" });
        }),
      );
      expect(portal.url).toContain("portal");
    }),
  );

  it.effect("bills a proration as one invoice with one line item", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers,
        client: recording(asked),
      });
      expect(provider.capabilities.has("invoice")).toBe(true);
      const invoice = yield* runWith(
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
      expect(asked[0]).toMatchObject({
        customerExternalId: "acct_1",
        amount: 8_000,
        currency: "usd",
        description: "Plan change",
      });
    }),
  );

  it.effect("a vendor failure is a declined payment the model can record", () =>
    Effect.gen(function* () {
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers,
        client: {
          ...recording(),
          createCheckoutSession: () =>
            Effect.fail(
              new PaymentDeclined({
                provider: "stripe",
                code: "card_declined",
                message: "card_declined",
              }),
            ),
        },
      });
      const error = yield* Effect.flip(
        runWith(
          provider,
          Effect.gen(function* () {
            return yield* (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" });
          }),
        ),
      );
      expect(error).toBeInstanceOf(PaymentDeclined);
      if (error._tag === "PaymentDeclined") expect(error.message).toContain("card_declined");
    }),
  );

  it.effect("a tier with no Stripe price is refused, not guessed", () =>
    Effect.gen(function* () {
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        client: recording(),
      });
      const error = yield* Effect.flip(
        runWith(
          provider,
          Effect.gen(function* () {
            return yield* (yield* Payments).createCheckout({ account: "acct_1", tier: "pro" });
          }),
        ),
      );
      expect(error).toBeInstanceOf(PaymentDeclined);
    }),
  );

  it("a processor declares what it owns, and Stack sees the price", () => {
    const provider = Stripe({
      secretKey: Redacted.make("sk_test_1"),
      origin: "https://app.example.com",
      tiers,
      client: recording(),
    });
    expect(provider.kind).toBe("processor");
    expect(provider.capabilities.has("checkout")).toBe(true);
    expect(provider.capabilities.has("invoice")).toBe(true);
    expect(provider.capabilities.has("refund")).toBe(true);
    expect(provider.prices).toEqual({ pro: proPrice });
    expect(stripePriceOf({ tiers }, "pro")).toEqual(proPrice);
    expect(stripePriceOf({ tiers }, "scale")).toBe(null);
  });

  it.effect("declares no capability the client does not implement", () =>
    Effect.gen(function* () {
      const partial: StripeClient = {
        createCheckoutSession: recording().createCheckoutSession,
        createBillingPortalSession: recording().createBillingPortalSession,
        createInvoice: recording().createInvoice,
      };
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers,
        client: partial,
      });
      expect(provider.capabilities.has("refund")).toBe(false);
      const error = yield* Effect.flip(
        runWith(
          provider,
          Effect.gen(function* () {
            return yield* (yield* Payments).refund({ chargeId: "ch_1", amount: 100 });
          }),
        ),
      );
      expect(error).toBeInstanceOf(ProviderCapabilityMissing);
    }),
  );

  it("builds the real client from the key, so a deployment needs no wiring", () => {
    const provider = Stripe({
      secretKey: Redacted.make("sk_test_1"),
      origin: "https://app.example.com",
    });
    expect(provider.kind).toBe("processor");
    expect(stripeBaseUrl({})).toBe(STRIPE_API_BASE_URL);
    const client = distilledStripeClient({ secretKey: Redacted.make("sk_test_1") });
    expect(typeof client.createCheckoutSession).toBe("function");
    expect(typeof client.createBillingPortalSession).toBe("function");
    expect(typeof client.createInvoice).toBe("function");
    expect(typeof client.createRefund).toBe("function");
  });

  it("maps the client to the port without the port knowing Stripe", () => {
    const { bindings } = stripeClientBindings(recording(), { origin: "https://app.example.com" });
    expect(typeof bindings.createCheckoutSession).toBe("function");
    expect(typeof bindings.createCustomerSession).toBe("function");
    expect(typeof bindings.createInvoice).toBe("function");
  });
});
