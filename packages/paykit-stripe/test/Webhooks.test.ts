import { describe, expect, it } from "@alchemy.run/test";
import { WebhookSignatureInvalid } from "@potion.run/paykit";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { stripeWebhook } from "../src/Webhooks.ts";
import { assertProperty } from "./support/Property.ts";

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
      payment_intent: "pi_1",
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
        chargeId: "pi_1",
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

      expect(error).toBeInstanceOf(WebhookSignatureInvalid);
    }),
  );

  it.effect("refuses a request older than the tolerance", () =>
    Effect.gen(function* () {
      const stale = String(Math.floor(nowSeconds()) - 3_600);
      const error = yield* Effect.flip(webhook(request({ body: session(), timestamp: stale })));
      expect(error).toBeInstanceOf(WebhookSignatureInvalid);
    }),
  );

  it.effect("refuses a request with no signature header", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(webhook({ headers: {}, body: JSON.stringify(session()) }));
      expect(error).toBeInstanceOf(WebhookSignatureInvalid);
    }),
  );

  it.effect("a body or signature changed after signing is refused", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          suffix: Schema.Literals(["x", " ", "}", "\n"]),
          flip: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 63 }))),
        }),
      ),
      ({ suffix, flip }) =>
        Effect.gen(function* () {
          const body = JSON.stringify(session());
          const timestamp = String(Math.floor(nowSeconds()));
          const signature = sign(body, timestamp);

          // The untampered request is the control: the generated fault must be
          // what fails, not the fixture.
          const valid = yield* Effect.result(webhook(request({ body, timestamp, signature })));

          if (Result.isFailure(valid) || Option.isNone(valid.success)) return false;

          const bodyTampered = yield* Effect.result(
            webhook(request({ body: body + suffix, timestamp, signature })),
          );

          if (
            !Result.isFailure(bodyTampered) ||
            bodyTampered.failure._tag !== "WebhookSignatureInvalid"
          ) {
            return false;
          }

          // One hex digit of the v1 tag, changed after signing.
          const start = signature.indexOf("v1=") + "v1=".length;
          const at = start + flip;
          const replacement = signature[at] === "a" ? "b" : "a";
          const flipped = `${signature.slice(0, at)}${replacement}${signature.slice(at + 1)}`;

          const signatureTampered = yield* Effect.result(
            webhook(request({ body, timestamp, signature: flipped })),
          );

          return (
            Result.isFailure(signatureTampered) &&
            signatureTampered.failure._tag === "WebhookSignatureInvalid"
          );
        }),
      { runs: 40, size: 10 },
    ),
  );
});
