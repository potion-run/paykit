import { describe, expect, it } from "@alchemy.run/test";
import { WebhookInvalid, WebhookSignatureInvalid } from "@potion.run/paykit";
import * as Output from "alchemy/Output";
import { RuntimeContext, type BaseRuntimeContext } from "alchemy/RuntimeContext";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { polarWebhook } from "../src/Webhooks.ts";
import { assertProperty } from "./support/Property.ts";
import { proPrice, request, secret, sign, tiers } from "./support/Webhook.ts";

const webhook = polarWebhook({ secret: Redacted.make(secret), tiers });

/** The instant every test signs at, so a timestamp is a fixture. */
export const at = 1_700_000_000_000;
const atSeconds = String(at / 1000);

/** Run the webhook at the instant the fixtures are signed at. */
const translate = (
  input: Omit<Parameters<typeof request>[0], "timestamp"> & { readonly timestamp?: string },
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);

    return yield* webhook(request({ timestamp: atSeconds, ...input }));
  });

const orderPaid = {
  type: "order.paid",
  data: {
    id: "ord_1",
    status: "paid",
    product_id: "prod_123",
    total_amount: 1900,
    currency: "usd",
    customer: { id: "cus_1", external_id: "acct_1" },
  },
};

describe("Polar webhooks", () => {
  it.effect("verifies the Standard Webhooks test vector, then judges the payload", () =>
    Effect.gen(function* () {
      // The published vector: if the key derivation or the signed string were
      // wrong, this would be a signature failure instead of a payload one.
      yield* TestClock.setTime(1_614_265_330_000);

      const exit = yield* Effect.exit(
        webhook({
          headers: {
            "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
            "webhook-timestamp": "1614265330",
            "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
          },
          body: '{"test": 2432232314}',
        }),
      );

      expect(exit._tag).toBe("Failure");

      if (exit._tag !== "Failure") return;
      // Not a `WebhookSignatureInvalid`: the signature was accepted.
      expect(String(exit.cause)).toContain("WebhookInvalid");
      expect(String(exit.cause)).not.toContain("WebhookSignatureInvalid");
    }),
  );

  it.effect("resolves a product handle a deploy created before the delivery", () => {
    const context: BaseRuntimeContext = {
      Type: "Test",
      id: "test",
      env: {},
      set: (key) => Effect.succeed(key),
      get: <T>() => Effect.succeed("prod_123" as T),
    };

    const deferred = polarWebhook({
      secret: Redacted.make(secret),
      tiers: { pro: { price: proPrice, productId: Output.literal("prod_123") } },
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(at);

      const event = Option.getOrThrow(
        yield* deferred(request({ timestamp: atSeconds, body: orderPaid })),
      );

      expect(event.tier).toBe("pro");
    }).pipe(Effect.provideService(RuntimeContext, context));
  });

  it.effect("turns order.paid into a payment the model can record", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(yield* translate({ body: orderPaid }));
      expect(event).toEqual({
        id: "msg_1",
        provider: "polar",
        kind: "payment_succeeded",
        account: "acct_1",
        reference: "ord_1",
        tier: "pro",
        amount: 1900,
        currency: "usd",
        chargeId: "ord_1",
      });
    }),
  );

  it.effect("turns a succeeded checkout into a completed one, and ignores the rest", () =>
    Effect.gen(function* () {
      const checkout = (status: string) => ({
        type: "checkout.updated",
        data: {
          id: "ch_1",
          status,
          external_customer_id: "acct_1",
          product_id: "prod_123",
          total_amount: 1900,
          currency: "usd",
        },
      });

      const succeeded = Option.getOrThrow(yield* translate({ body: checkout("succeeded") }));
      expect(succeeded.kind).toBe("checkout_completed");
      expect(succeeded.reference).toBe("ch_1");
      expect(succeeded.tier).toBe("pro");
      expect(succeeded.amount).toBe(1900);
      expect(Option.isNone(yield* translate({ body: checkout("open") }))).toBe(true);
      expect(Option.isNone(yield* translate({ body: checkout("expired") }))).toBe(true);
    }),
  );

  it.effect("turns subscription.past_due into a failed payment", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(
        yield* translate({
          body: {
            type: "subscription.past_due",
            data: {
              id: "sub_1",
              product_id: "prod_123",
              amount: 1900,
              currency: "usd",
              customer: { id: "cus_1", external_id: "acct_1" },
            },
          },
        }),
      );

      expect(event.kind).toBe("payment_failed");
      expect(event.reference).toBe("sub_1");
      expect(event.reason).toBe("past_due");
      expect(event.account).toBe("acct_1");
    }),
  );

  it.effect("turns canceled and revoked subscriptions into a cancellation", () =>
    Effect.gen(function* () {
      for (const type of ["subscription.canceled", "subscription.revoked"]) {
        const event = Option.getOrThrow(
          yield* translate({
            body: {
              type,
              data: {
                id: "sub_1",
                product_id: "prod_123",
                amount: 1900,
                currency: "usd",
                customer: { id: "cus_1", external_id: "acct_1" },
              },
            },
          }),
        );

        expect(event.kind).toBe("subscription_canceled");
        expect(event.reference).toBe("sub_1");
        expect(event.account).toBe("acct_1");
      }
    }),
  );

  it.effect("ignores an event paykit does not model", () =>
    Effect.gen(function* () {
      const event = yield* translate({ body: { type: "product.updated", data: { id: "p_1" } } });
      expect(Option.isNone(event)).toBe(true);
    }),
  );

  it.effect("leaves the tier off a product no tier maps, rather than inventing one", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(
        yield* translate({
          body: {
            ...orderPaid,
            data: { ...orderPaid.data, product_id: "prod_unknown" },
          },
        }),
      );

      expect(event.kind).toBe("payment_succeeded");
      expect(event.tier).toBe(undefined);
    }),
  );

  it.effect("verifies a legacy secret, whose key is the secret's own bytes", () =>
    Effect.gen(function* () {
      const event = Option.getOrThrow(yield* translate({ body: orderPaid, legacy: true }));
      expect(event.kind).toBe("payment_succeeded");
    }),
  );

  it.effect("refuses a signature that does not match", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        translate({
          body: orderPaid,
          signature: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        }),
      );

      expect(error).toBeInstanceOf(WebhookSignatureInvalid);
    }),
  );

  it.effect("refuses a request older than the tolerance", () =>
    Effect.gen(function* () {
      const stale = { body: orderPaid, timestamp: String(at / 1000 - 3_600) };
      const error = yield* Effect.flip(translate(stale));
      expect(error).toBeInstanceOf(WebhookSignatureInvalid);

      if (error._tag === "WebhookSignatureInvalid") {
        expect(error.provider).toBe("polar");
        expect(error.reason).toContain("tolerance");
      }
    }),
  );

  it.effect("refuses a request with no signature header", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at);

      const error = yield* Effect.flip(
        webhook({ headers: { "webhook-id": "msg_1" }, body: JSON.stringify(orderPaid) }),
      );

      expect(error).toBeInstanceOf(WebhookSignatureInvalid);
    }),
  );

  it.effect("a body or signature changed after signing is refused", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          suffix: Schema.Literals(["x", " ", "}", "\n"]),
          flip: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 43 }))),
        }),
      ),
      ({ suffix, flip }) =>
        Effect.gen(function* () {
          const body = JSON.stringify(orderPaid);
          const signature = sign({ id: "msg_1", timestamp: atSeconds, body });

          const valid = yield* Effect.result(translate({ body, signature }));

          if (Result.isFailure(valid) || Option.isNone(valid.success)) return false;

          const bodyTampered = yield* Effect.result(translate({ body: body + suffix, signature }));

          if (
            !Result.isFailure(bodyTampered) ||
            bodyTampered.failure._tag !== "WebhookSignatureInvalid"
          ) {
            return false;
          }

          // One character of the base64 tag, changed after signing.
          const start = "v1,".length;
          const index = start + flip;
          const replacement = signature[index] === "A" ? "B" : "A";
          const flipped = `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
          const signatureTampered = yield* Effect.result(translate({ body, signature: flipped }));

          return (
            Result.isFailure(signatureTampered) &&
            signatureTampered.failure._tag === "WebhookSignatureInvalid"
          );
        }),
      { runs: 40, size: 10 },
    ),
  );

  it.effect("any valid v1 entry in a multi-signature header is accepted", () =>
    assertProperty(
      Arbitrary.schema(Schema.Literals(["valid-last", "valid-first", "garbage-first"])),
      (order) =>
        Effect.gen(function* () {
          const body = JSON.stringify(orderPaid);
          const valid = sign({ id: "msg_1", timestamp: atSeconds, body });
          const invalid = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

          const signature =
            order === "valid-last"
              ? `${invalid} ${valid}`
              : order === "valid-first"
                ? `${valid} ${invalid}`
                : `garbage ${valid}`;

          const result = yield* Effect.result(translate({ body, signature }));

          return !Result.isFailure(result) && Option.isSome(result.success);
        }),
      { runs: 3, size: 1 },
    ),
  );

  it.effect("refuses an order with no external customer id, naming the field", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        translate({
          body: { ...orderPaid, data: { ...orderPaid.data, customer: { id: "cus_1" } } },
        }),
      );

      expect(error).toBeInstanceOf(WebhookInvalid);

      if (error._tag === "WebhookInvalid") expect(error.field).toBe("account");
    }),
  );
});
