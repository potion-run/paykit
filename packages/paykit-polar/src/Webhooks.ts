import {
  resolvePolarProductId,
  type PolarTier,
  type WebhookError,
  type WebhookEvent,
  type WebhookRequest,
  WebhookInvalid,
  WebhookSignatureInvalid,
} from "@potion.run/paykit";
import * as Clock from "effect/Clock";
import { Mac, SecureRandom } from "effect/crypto";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The only errors the webhook translation may return. */
export type PolarWebhookError = WebhookError;

/** A Polar delivery: the body and the headers that signed it. */
export type PolarWebhookRequest = WebhookRequest;

/** What `polarWebhook` needs: the signing secret and the tier → product map. */
export interface PolarWebhookProps {
  /**
   * The endpoint's signing secret, from Polar's dashboard. A secret, so it
   * arrives redacted: `yield* Config.redacted("POLAR_WEBHOOK_SECRET")`.
   */
  readonly secret: Redacted.Redacted<string>;
  /** Tier → Polar product, the same map `Polar()` was given. */
  readonly tiers?: Readonly<Record<string, PolarTier>>;
  /** How old a signed request may be. Polar's spec recommends five minutes. */
  readonly toleranceSeconds?: number;
}

/**
 * The WebCrypto HMAC a Worker runs. `verify` is the only op used, so the layer
 * is built once here and provided at the one signature check.
 */
const HMAC = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

/** `v1,<signature>` entries, space separated, as Standard Webhooks sends them. */
const signaturesOf = (header: string): ReadonlyArray<string> =>
  header
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => entry.slice("v1,".length));

/**
 * Both key derivations Polar has shipped: the Standard Webhooks one (base64
 * after `whsec_`) and the legacy one (the UTF-8 bytes of the whole secret). A
 * secret created before 2026-09-08 only verifies with the second.
 */
const keysOf = (secret: string): ReadonlyArray<Uint8Array> => {
  const body = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const standard = Result.getOrNull(Base64.decode(body));
  const legacy = new TextEncoder().encode(secret);

  return standard === null ? [legacy] : [standard, legacy];
};

/**
 * Check the Standard Webhooks signature: HMAC-SHA256 over
 * `${id}.${timestamp}.${body}`, compared in constant time against every
 * `v1` entry the header carries.
 */
const verifySignature = (input: {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly body: string;
  readonly secret: string;
  readonly toleranceSeconds: number;
}): Effect.Effect<void, WebhookSignatureInvalid> =>
  Effect.gen(function* () {
    const seconds = Number(input.timestamp);

    if (!Number.isFinite(seconds)) {
      return yield* new WebhookSignatureInvalid({
        provider: "polar",
        reason: "webhook-timestamp is not a number",
      });
    }

    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    if (Math.abs(now - seconds) > input.toleranceSeconds) {
      return yield* new WebhookSignatureInvalid({
        provider: "polar",
        reason: "webhook-timestamp is outside the tolerance",
      });
    }

    const mac = yield* Mac.Mac;
    const signed = new TextEncoder().encode(`${input.id}.${input.timestamp}.${input.body}`);

    // Every `v1` entry, decoded: `verify` compares in constant time, where
    // comparing the base64 strings would leak a matching prefix.
    const given = signaturesOf(input.signature)
      .map((entry) => Result.getOrNull(Base64.decode(entry)))
      .filter((tag): tag is Uint8Array => tag !== null);

    for (const bytes of keysOf(input.secret)) {
      const key = yield* Mac.key(Mac.hmacSha256, bytes);

      for (const tag of given) {
        if (yield* mac.verify(key, tag, signed)) return;
      }
    }

    return yield* new WebhookSignatureInvalid({
      provider: "polar",
      reason: "webhook-signature does not match",
    });
  }).pipe(
    // A runtime without WebCrypto cannot verify anything; that is a defect in
    // the deployment, not a verdict on the request.
    Effect.catchTag("CryptoError", (cause) => Effect.die(cause)),
    Effect.provide(HMAC),
  );

/** The envelope Polar posts: a type and the object the type names. */
const Envelope = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, data: Schema.Unknown }),
);

/** The fields of `Polar.Checkout` this translation reads. */
const CheckoutPayload = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.String,
  external_customer_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  product_id: Schema.NullOr(Schema.String),
  total_amount: Schema.Int,
  currency: Schema.String,
});

/** The fields of `Polar.Order` this translation reads. */
const OrderPayload = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  product_id: Schema.NullOr(Schema.String),
  total_amount: Schema.Int,
  currency: Schema.String,
  customer: Schema.Struct({ external_id: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
});

/** The fields of `Polar.Subscription` this translation reads. */
const SubscriptionPayload = Schema.Struct({
  product_id: Schema.String,
  amount: Schema.Int,
  currency: Schema.String,
  customer: Schema.Struct({ external_id: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
});

const header = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }

  return undefined;
};

/**
 * Verify and translate one Polar webhook into paykit's provider-neutral event.
 *
 * `polarWebhook(props)` returns the function a `/webhooks/polar` route calls:
 * it checks the Standard Webhooks signature, decodes the payload, and answers
 * the `WebhookEvent` `handleWebhook` already knows how to apply — or `none`
 * for a Polar event paykit does not model, which the route answers 200 and
 * ignores.
 *
 * The `webhook-id` header is the event id, so it becomes the command id: a
 * redelivery replays rather than activating, charging or cancelling twice.
 *
 * ### Handling a Polar webhook
 * **Example:** One route, one translation
 * ```typescript
 * const webhook = polarWebhook({
 *   secret: yield* Config.redacted("POLAR_WEBHOOK_SECRET"),
 *   tiers,
 * });
 *
 * return Effect.gen(function* () {
 *   const event = yield* webhook({ headers: Object.fromEntries(request.headers), body });
 *   if (Option.isSome(event)) yield* handleWebhook(event.value);
 *   return new Response(null, { status: 202 });
 * });
 * ```
 *
 * @primitive
 */
export const polarWebhook = (
  props: PolarWebhookProps,
): ((
  request: PolarWebhookRequest,
) => Effect.Effect<Option.Option<WebhookEvent>, PolarWebhookError>) => {
  // A hand-written config carries ids, so the common lookup stays a Map. A
  // product created by `PolarBilling` is still an Output when the provider is
  // declared, so its handle is resolved only for a delivery that names an id
  // no plain entry matched.
  const byProduct = new Map<string, string>();
  const deferred: Array<readonly [string, PolarTier]> = [];

  for (const [tier, mapped] of Object.entries(props.tiers ?? {})) {
    if (typeof mapped.productId === "string") byProduct.set(mapped.productId, tier);
    else deferred.push([tier, mapped]);
  }

  const secret = Redacted.value(props.secret);
  const toleranceSeconds = props.toleranceSeconds ?? 300;

  return Effect.fn("Polar.webhook")(function* (request: PolarWebhookRequest) {
    const id = header(request.headers, "webhook-id");
    const timestamp = header(request.headers, "webhook-timestamp");
    const signature = header(request.headers, "webhook-signature");

    if (id === undefined) {
      return yield* new WebhookSignatureInvalid({
        provider: "polar",
        reason: "missing webhook-id header",
      });
    }

    if (timestamp === undefined) {
      return yield* new WebhookSignatureInvalid({
        provider: "polar",
        reason: "missing webhook-timestamp header",
      });
    }

    if (signature === undefined) {
      return yield* new WebhookSignatureInvalid({
        provider: "polar",
        reason: "missing webhook-signature header",
      });
    }

    yield* verifySignature({
      id,
      timestamp,
      signature,
      body: request.body,
      secret,
      toleranceSeconds,
    });

    const envelope = yield* Schema.decodeEffect(Envelope)(request.body).pipe(
      Effect.mapError(() => new WebhookInvalid({ event: id, field: "payload" })),
    );

    const invalid = (field: string) => new WebhookInvalid({ event: id, field });
    const none = Option.none<WebhookEvent>();

    // A product no tier maps is not a standing change: the event is dropped
    // rather than refused, so an unrelated one-off product does not make the
    // endpoint retry forever. A tier is never invented.
    const tierOf = (productId: string | null): Effect.Effect<{ readonly tier?: string }> => {
      if (productId === null) return Effect.succeed({});
      const known = byProduct.get(productId);

      if (known !== undefined) return Effect.succeed({ tier: known });

      return Effect.gen(function* () {
        for (const [tier, mapped] of deferred) {
          if ((yield* resolvePolarProductId(mapped.productId)) === productId) {
            return { tier };
          }
        }

        return {};
      });
    };

    switch (envelope.type) {
      case "checkout.updated": {
        const checkout = yield* Schema.decodeUnknownEffect(CheckoutPayload)(envelope.data).pipe(
          Effect.mapError(() => invalid("payload")),
        );

        if (checkout.status !== "succeeded") return none;
        const account = checkout.external_customer_id;

        if (account === null || account === undefined) return yield* invalid("account");

        return Option.some({
          id,
          provider: "polar",
          kind: "checkout_completed",
          account,
          ...(yield* tierOf(checkout.product_id)),
          amount: checkout.total_amount,
          currency: checkout.currency,
          ...(checkout.id === null || checkout.id === undefined ? {} : { chargeId: checkout.id }),
        });
      }

      case "order.paid": {
        const order = yield* Schema.decodeUnknownEffect(OrderPayload)(envelope.data).pipe(
          Effect.mapError(() => invalid("payload")),
        );

        const account = order.customer.external_id;

        if (account === null || account === undefined) return yield* invalid("account");

        return Option.some({
          id,
          provider: "polar",
          kind: "payment_succeeded",
          account,
          ...(yield* tierOf(order.product_id)),
          amount: order.total_amount,
          currency: order.currency,
          ...(order.id === null || order.id === undefined ? {} : { chargeId: order.id }),
        });
      }

      case "subscription.past_due": {
        const subscription = yield* Schema.decodeUnknownEffect(SubscriptionPayload)(
          envelope.data,
        ).pipe(Effect.mapError(() => invalid("payload")));

        const account = subscription.customer.external_id;

        if (account === null || account === undefined) return yield* invalid("account");

        return Option.some({
          id,
          provider: "polar",
          kind: "payment_failed",
          account,
          ...(yield* tierOf(subscription.product_id)),
          amount: subscription.amount,
          currency: subscription.currency,
          reason: "past_due",
        });
      }

      case "subscription.canceled":
      case "subscription.revoked": {
        const subscription = yield* Schema.decodeUnknownEffect(SubscriptionPayload)(
          envelope.data,
        ).pipe(Effect.mapError(() => invalid("payload")));

        const account = subscription.customer.external_id;

        if (account === null || account === undefined) return yield* invalid("account");

        return Option.some({
          id,
          provider: "polar",
          kind: "subscription_canceled",
          account,
          ...(yield* tierOf(subscription.product_id)),
        });
      }

      default:
        // Every other Polar event is not a standing change: the route answers
        // 200 and records nothing.
        return none;
    }
  });
};
