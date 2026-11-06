import { describe, expect, it } from "@alchemy.run/test";
import { PaymentDeclined, Payments, ProviderCapabilityMissing } from "@potion.run/paykit";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
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
      return { url: `https://checkout.stripe.test/${request.priceIds.join(",")}` };
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
  charge: (request) =>
    Effect.sync(() => {
      asked.push(request as never);
      return { chargeId: "pi_off_session" };
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
          return yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
            kind: "subscription",
          });
        }),
      );
      expect(session.url).toContain("price_123");
      expect(asked[0]).toMatchObject({
        priceIds: ["price_123"],
        tier: "pro",
        customerExternalId: "acct_1",
        successUrl: "https://app.example.com/welcome",
        cancelUrl: "https://app.example.com/pricing",
      });
    }),
  );

  it.effect("attaches the metered price and reports the period's units", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const unitPrice = { amount: 2, currency: "usd" } as const;
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers: {
          pro: {
            price: proPrice,
            priceId: "price_123",
            usage: { messages: { unitPrice, priceId: "price_msg" } },
          },
        },
        meters: { messages: "paykit_prod_messages" },
        client: {
          ...recording(asked),
          reportUsage: (request) =>
            Effect.sync(() => {
              asked.push(request as never);
              return {};
            }),
        },
      });

      expect(provider.capabilities.has("usage")).toBe(true);
      expect(provider.unitPrices).toEqual({ pro: { messages: unitPrice } });
      const session = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
            kind: "subscription",
          });
        }),
      );
      expect(session.url).toContain("price_123,price_msg");

      const periodStart = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
      const periodEnd = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
      yield* runWith(
        provider,
        Effect.gen(function* () {
          yield* (yield* Payments).reportUsage({
            account: "acct_1",
            periodStart,
            periodEnd,
            lines: [
              { feature: "messages", unitPrice: { amount: 2, currency: "usd" }, quantity: 50 },
            ],
            commandId: "period-usage:1:2",
          });
        }),
      );
      // One meter event per line, keyed by the period, the account, the feature
      // and the price: one period can record a feature at two prices.
      expect(asked.at(-1)).toMatchObject({
        eventName: "paykit_prod_messages",
        customerExternalId: "acct_1",
        quantity: 50,
        identifier: "period-usage:1:2:acct_1:messages:usd:2",
        timestamp: Math.floor(DateTime.toEpochMillis(periodEnd) / 1000),
      });
    }),
  );

  it.effect("opens a one-off purchase and forwards the kind", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers,
        client: recording(asked),
      });
      yield* runWith(
        provider,
        Effect.gen(function* () {
          yield* (yield* Payments).createCheckout({
            account: "acct_1",
            tier: "pro",
            kind: "one_off",
          });
        }),
      );
      expect(asked[0]).toMatchObject({ tier: "pro", kind: "one_off" });
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
            return yield* (yield* Payments).createCheckout({
              account: "acct_1",
              tier: "pro",
              kind: "subscription",
            });
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
            return yield* (yield* Payments).createCheckout({
              account: "acct_1",
              tier: "pro",
              kind: "subscription",
            });
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
    expect(provider.capabilities.has("charge")).toBe(true);
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
      expect(provider.capabilities.has("charge")).toBe(false);
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

  it.live("carries its own webhook, so the secret and the tiers are wired once", () =>
    Effect.gen(function* () {
      const provider = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
        tiers,
        webhookSecret: Redacted.make("whsec_e2e"),
        client: recording(),
      });
      expect(provider.webhook?.provider).toBe("stripe");
      const body = JSON.stringify({ id: "evt_1", type: "customer.created", data: { object: {} } });
      const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000));
      const tag = new Bun.CryptoHasher("sha256", new TextEncoder().encode("whsec_e2e"))
        .update(`${timestamp}.${body}`)
        .digest("hex");
      const decoded = yield* provider.webhook!.decode({
        headers: { "stripe-signature": `t=${timestamp},v1=${tag}` },
        body,
      });
      expect(decoded._tag).toBe("None");

      const bare = Stripe({
        secretKey: Redacted.make("sk_test_1"),
        origin: "https://app.example.com",
      });
      expect(bare.webhook).toBe(undefined);
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
