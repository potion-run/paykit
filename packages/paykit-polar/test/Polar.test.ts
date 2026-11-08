import { describe, expect, it } from "@alchemy.run/test";
import { PaymentDeclined, Payments, ProviderCapabilityMissing } from "@potion.run/paykit";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Polar, polarBindings, polarPriceOf, type PolarClient } from "../src/Polar.ts";
import { distilledPolarClient, POLAR_BASE_URL, polarBaseUrl } from "../src/PolarClient.ts";
import { request, secret } from "./support/Webhook.ts";

/** What the Polar SDK raises: tagged, so it never enters a failure channel as `unknown`. */
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const tiers = { pro: { price: proPrice, productId: "prod_123" } };

/** A stand-in for Polar, recording what the adapter asked for. */
const recording = (asked: Array<Record<string, unknown>>): PolarClient => ({
  createCheckoutSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { url: "https://polar.sh/checkout/cs_1" };
    }),
  createCustomerSession: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { url: "https://polar.sh/portal/cs_1" };
    }),
  createInvoice: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { invoiceId: "ord_proration_1" };
    }),
  createRefund: (request) =>
    Effect.sync(() => {
      asked.push(request as never);

      return { refundId: "re_test" };
    }),
});

const runWith = <A, E, R>(provider: ReturnType<typeof Polar>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(provider.payments)) as Effect.Effect<A, E | PaymentDeclined, never>;

describe("Polar as a paykit provider", () => {
  it.effect("sells a tier through one checkout, with the product the catalog maps", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];

      const provider = Polar({
        accessToken: "polar_t",
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

      expect(session.url).toContain("polar.sh");
      expect(asked[0]).toMatchObject({
        productId: "prod_123",
        customerExternalId: "acct_1",
        successUrl: "https://app.example.com/welcome",
        returnUrl: "https://app.example.com/billing",
      });
    }),
  );

  it.effect("sets the subscription's seat count and leaves the proration to the collector", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const seatPrice = { amount: 1_000, currency: "usd" } as const;

      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers: {
          pro: { price: proPrice, productId: "prod_123", seats: { seats: seatPrice } },
        },
        client: {
          ...recording(asked),
          setSubscriptionSeats: (request) =>
            Effect.sync(() => {
              asked.push(request as never);

              return {};
            }),
        },
      });

      expect(provider.capabilities.has("quantity")).toBe(true);
      expect(provider.seatScope).toBe("subscription");
      expect(provider.seatPrices).toEqual({ pro: { seats: seatPrice } });

      const result = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).setQuantity({
            account: "acct_1",
            subscription: "sub_1",
            tier: "pro",
            feature: "seats",
            quantity: 8,
            proration: "immediate",
            commandId: "seats:add",
          });
        }),
      );

      // No invoice id: the local collector opens the order for an immediate
      // change, and Polar's next renewal bills the new count.
      expect(result).toEqual({});
      expect(asked[0]).toMatchObject({ subscription: "sub_1", seats: 8, commandId: "seats:add" });
    }),
  );

  it.effect("reports a closing period's units to the feature's meter", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];
      const unitPrice = { amount: 2, currency: "usd" } as const;

      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers: { pro: { price: proPrice, productId: "prod_123", usage: { messages: unitPrice } } },
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

      const periodEnd = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
      yield* runWith(
        provider,
        Effect.gen(function* () {
          yield* (yield* Payments).reportUsage({
            account: "acct_1",
            periodStart: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
            periodEnd,
            lines: [
              { feature: "messages", unitPrice: { amount: 2, currency: "usd" }, quantity: 50 },
            ],
            commandId: "period-usage:1:2",
          });
        }),
      );
      expect(asked.at(-1)).toMatchObject({
        eventName: "paykit_prod_messages",
        externalCustomerId: "acct_1",
        quantity: 50,
        externalId: "period-usage:1:2:acct_1:messages:usd:2",
        timestamp: DateTime.formatIso(periodEnd),
      });
    }),
  );

  it.effect("opens the customer portal through a customer session", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];

      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers,
        client: recording(asked),
      });

      const portal = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createPortal({ account: "acct_1" });
        }),
      );

      expect(portal.url).toContain("portal");
      expect(asked[0]).toMatchObject({ customerExternalId: "acct_1" });
    }),
  );

  it.effect("a vendor failure is a declined payment the model can record", () =>
    Effect.gen(function* () {
      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers,
        client: {
          ...recording([]),
          createCheckoutSession: () =>
            Effect.fail(
              new PaymentDeclined({
                provider: "polar",
                code: "insufficient_funds",
                message: "insufficient_funds",
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

      if ((error as PaymentDeclined)._tag === "PaymentDeclined")
        expect((error as PaymentDeclined).message).toContain("insufficient_funds");
    }),
  );

  it.effect("a tier with no Polar product is refused, not guessed", () =>
    Effect.gen(function* () {
      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        client: recording([]),
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

  it("a merchant of record declares what it owns, and Stack sees the price", () => {
    const provider = Polar({
      accessToken: "polar_t",
      origin: "https://app.example.com",
      tiers,
      client: recording([]),
    });

    expect(provider.kind).toBe("merchant_of_record");
    expect(provider.capabilities.has("checkout")).toBe(true);
    // Polar owns tax and receipts; paykit still owns the entitlement.
    expect(provider.prices).toEqual({ pro: proPrice });
    expect(polarPriceOf({ tiers }, "pro")).toEqual(proPrice);
    expect(polarPriceOf({ tiers }, "scale")).toBe(null);
  });

  it.effect("builds the real client from the token, so a deployment needs no wiring", () =>
    Effect.gen(function* () {
      // No `client`: the distilled SDK is what a deployment gets.
      const provider = Polar({ accessToken: "polar_t", origin: "https://app.example.com" });
      expect(provider.kind).toBe("merchant_of_record");
      // Sandbox is a different host, so a test key cannot hit production.
      expect(polarBaseUrl({})).toBe("https://api.polar.sh");
      expect(polarBaseUrl({ server: "sandbox" })).toBe("https://sandbox-api.polar.sh");
      expect(POLAR_BASE_URL.production).not.toBe(POLAR_BASE_URL.sandbox);
      const client = distilledPolarClient({ accessToken: Redacted.make("polar_t") });
      expect(typeof client.createCheckoutSession).toBe("function");
      expect(typeof client.createCustomerSession).toBe("function");
      expect(typeof client.createRefund).toBe("function");
    }),
  );

  it("maps the client to the port without the port knowing Polar", () => {
    const bindings = polarBindings(recording([]), { origin: "https://app.example.com" });
    expect(typeof bindings.createCheckoutSession).toBe("function");
    expect(typeof bindings.createCustomerSession).toBe("function");
  });

  it.effect("bills a one-off order when an invoice product is configured", () =>
    Effect.gen(function* () {
      const asked: Array<Record<string, unknown>> = [];

      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers,
        invoiceProductId: "prod_proration",
        client: recording(asked),
      });

      expect(provider.capabilities.has("invoice")).toBe(true);

      const invoice = yield* runWith(
        provider,
        Effect.gen(function* () {
          return yield* (yield* Payments).createInvoice({
            account: "acct_1",
            amount: 8000,
            currency: "usd",
          });
        }),
      );

      expect(invoice.invoiceId).toBe("ord_proration_1");
      expect(asked[0]).toMatchObject({
        customerExternalId: "acct_1",
        productId: "prod_proration",
        amount: 8000,
        currency: "usd",
        description: "Plan change",
      });
    }),
  );

  it.effect("carries its own webhook, so the secret and the tiers are wired once", () =>
    Effect.gen(function* () {
      const provider = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        tiers,
        webhookSecret: Redacted.make(secret),
        client: recording([]),
      });

      expect(provider.webhook?.provider).toBe("polar");
      const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000));

      const decoded = yield* provider.webhook!.decode(
        request({ timestamp, body: { type: "product.updated", data: { id: "p_1" } } }),
      );

      expect(decoded._tag).toBe("None");

      const bare = Polar({
        accessToken: "polar_t",
        origin: "https://app.example.com",
        client: recording([]),
      });

      expect(bare.webhook).toBe(undefined);
    }),
  );

  it("declares no portal capability of its own beyond the session it has", () => {
    const provider = Polar({
      accessToken: "polar_t",
      origin: "https://app.example.com",
      tiers,
      client: recording([]),
    });

    // A capability this deployment did not configure must not be advertised.
    expect(provider.capabilities.has("invoice")).toBe(false);
    expect(ProviderCapabilityMissing).toBeDefined();
    expect(Layer.empty).toBeDefined();
  });
});
