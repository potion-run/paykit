import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { StripeSignatureInvalid, stripeWebhook } from "../src/Webhooks.ts";

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const tiers = { pro: { price: proPrice, priceId: "price_123" } };
const secret = "whsec_stripe_test_secret";
const webhook = stripeWebhook({ secret: Redacted.make(secret), tiers });

const nowSeconds = (): number => Math.floor(performance.timeOrigin + performance.now()) / 1000;

/**
 * An independent HMAC over Stripe's signed string, `"<timestamp>.<body>"`, in
 * the hex the `Stripe-Signature` header carries. `Bun.CryptoHasher` is not the
 * vendor's WebCrypto path, so a signature that verifies here proves both agree.
 */
const sign = (body: string, timestamp: string): string => {
  const tag = new Bun.CryptoHasher("sha256", new TextEncoder().encode(secret))
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${tag}`;
};

const request = (input: {
  readonly body: unknown;
  readonly timestamp?: string;
  readonly signature?: string;
}) => {
  const body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  const timestamp = input.timestamp ?? String(Math.floor(nowSeconds()));
  return {
    headers: {
      "content-type": "application/json",
      "stripe-signature": input.signature ?? sign(body, timestamp),
    },
    body,
  };
};

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_1",
      customer: "acct_1",
      client_reference_id: "acct_1",
      amount_total: 1900,
      currency: "usd",
      metadata: { tier: "pro" },
      ...overrides,
    },
  },
});

const invoice = (type: string) => ({
  id: "evt_2",
  type,
  data: {
    object: {
      id: "in_1",
      customer: "acct_1",
      amount_paid: 8000,
      currency: "usd",
      lines: { data: [{ price: { id: "price_123" } }] },
    },
  },
});

describe("Stripe webhooks", () => {
  it.effect("turns a completed checkout into a standing the model can activate", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(yield* webhook(request({ body: session() })));
      expect(event).toEqual({
        id: "evt_1",
        provider: "stripe",
        kind: "checkout_completed",
        account: "acct_1",
        tier: "pro",
        amount: 1900,
        currency: "usd",
      });
    }),
  );

  it.effect("turns invoice.paid into a payment, with the tier the price maps to", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(yield* webhook(request({ body: invoice("invoice.paid") })));
      expect(event.kind).toBe("payment_succeeded");
      expect(event.tier).toBe("pro");
      expect(event.amount).toBe(8000);
      expect(event.currency).toBe("usd");
    }),
  );

  it.effect("turns invoice.payment_failed into a failed payment", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(
        yield* webhook(request({ body: invoice("invoice.payment_failed") })),
      );
      expect(event.kind).toBe("payment_failed");
      expect(event.reason).toBe("invoice_payment_failed");
    }),
  );

  it.effect("turns a deleted subscription into a cancellation", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(
        yield* webhook(
          request({
            body: {
              id: "evt_3",
              type: "customer.subscription.deleted",
              data: {
                object: {
                  id: "sub_1",
                  customer: "acct_1",
                  items: { data: [{ price: { id: "price_123" } }] },
                },
              },
            },
          }),
        ),
      );
      expect(event.kind).toBe("subscription_canceled");
      expect(event.tier).toBe("pro");
    }),
  );

  it.effect("ignores an event paykit does not model", () =>
    Effect.gen(function* () {
      const event = yield* webhook(
        request({ body: { id: "evt_4", type: "customer.created", data: { object: {} } } }),
      );
      expect(Option.isNone(event)).toBe(true);
    }),
  );

  it.effect("leaves the tier off a price no tier maps, rather than inventing one", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(
        yield* webhook(
          request({
            body: {
              id: "evt_5",
              type: "invoice.paid",
              data: {
                object: {
                  id: "in_2",
                  customer: "acct_1",
                  amount_paid: 500,
                  currency: "usd",
                  lines: { data: [{ price: { id: "price_unknown" } }] },
                },
              },
            },
          }),
        ),
      );
      expect(event.tier).toBe(undefined);
      expect(event.amount).toBe(500);
    }),
  );

  it.effect("refuses a signature that does not match", () =>
    Effect.gen(function* () {
      const body = JSON.stringify(session());
      const error = yield* Effect.flip(
        webhook(
          request({
            body,
            signature: `t=${Math.floor(nowSeconds())},v1=${"0".repeat(64)}`,
          }),
        ),
      );
      expect(error).toBeInstanceOf(StripeSignatureInvalid);
    }),
  );

  it.effect("refuses a request older than the tolerance", () =>
    Effect.gen(function* () {
      const stale = String(Math.floor(nowSeconds()) - 3_600);
      const error = yield* Effect.flip(webhook(request({ body: session(), timestamp: stale })));
      expect(error).toBeInstanceOf(StripeSignatureInvalid);
    }),
  );

  it.effect("refuses a request with no signature header", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(webhook({ headers: {}, body: JSON.stringify(session()) }));
      expect(error).toBeInstanceOf(StripeSignatureInvalid);
    }),
  );

  it.effect("refuses a body the signature cannot be checked over", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(webhook(request({ body: "{not json" })));
      expect(String(error._tag)).toContain("WebhookInvalid");
    }),
  );
});
