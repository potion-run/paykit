import * as Domain from "@alchemy.run/domain";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";

/** One place an outbound event is POSTed, and the secret its signature uses. */
export interface OutboundEndpoint {
  readonly url: string;
  readonly secret: Redacted.Redacted<string>;
}

/** A signed request, ready for the app's transport to send. */
export interface OutboundRequest {
  readonly endpoint: OutboundEndpoint;
  /** The JSON body the signature covers. */
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Stable per account and event sequence, so a receiver can drop a replay. */
  readonly idempotencyKey: string;
}

/** The transport refused the delivery. The policy retries, then the platform does. */
export class OutboundDeliveryError extends Schema.TaggedError<OutboundDeliveryError>()(
  "OutboundDeliveryError",
  {
    endpoint: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * The outbound edge as a port: the endpoints to notify and the transport that
 * sends a signed request. Provide it beside the model; without it the policy
 * is a no-op, so a deployment that does not want push pays nothing for it.
 *
 * The app owns HTTP (a Worker, a queue, a test): paykit owns the event, the
 * signature and the idempotency key. That is the same split as `Payments`: the
 * model never talks to a vendor, and a port never decides a standing.
 *
 * ### Sending every event to one endpoint
 * **Example:** A transport that POSTs the signed body
 * ```ts
 * const outbound = Layer.succeed(Outbound, {
 *   endpoints: [{ url: "https://app.example/hooks/paykit", secret: Redacted.make(secret) }],
 *   deliver: ({ endpoint, body, headers }) =>
 *     Effect.gen(function* () {
 *       const response = yield* HttpClient.post(endpoint.url, { body, headers });
 *       if (response.status >= 300) {
 *         return yield* new OutboundDeliveryError({
 *           endpoint: endpoint.url,
 *           reason: `HTTP ${response.status}`,
 *         });
 *       }
 *     }),
 * });
 * ```
 *
 * @primitive
 */
export class Outbound extends Context.Service<
  Outbound,
  {
    readonly endpoints: ReadonlyArray<OutboundEndpoint>;
    readonly deliver: (request: OutboundRequest) => Effect.Effect<void, OutboundDeliveryError>;
  }
>()("paykit/Outbound") {}

const HMAC = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

/**
 * The `x-paykit-signature` header: HMAC-SHA256 over `<timestamp>.<body>`, hex
 * encoded, shaped like the inbound edges (`t=…,v1=…`). The timestamp is epoch
 * millis.
 */
export const outboundSignature = (input: {
  readonly secret: Redacted.Redacted<string>;
  readonly timestamp: number;
  readonly body: string;
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const mac = yield* Mac.Mac;

    const key = yield* Mac.key(
      Mac.hmacSha256,
      new TextEncoder().encode(Redacted.value(input.secret)),
    );

    const tag = yield* mac.sign(key, new TextEncoder().encode(`${input.timestamp}.${input.body}`));

    return `t=${input.timestamp},v1=${Hex.encode(tag)}`;
  }).pipe(Effect.provide(HMAC), Effect.orDie);

/**
 * Every committed subscription event, pushed to each configured endpoint.
 *
 * The policy runs after the event commits, at least once and in order per
 * account. The signature carries the timestamp, and the idempotency key is
 * `${account}:${seq}`, so a redelivery is a replay at the receiver. A failed
 * send is retried here and, if it still fails, by the platform's redelivery.
 */
export class OutboundEvents extends Domain.Policy("OutboundEvents", {
  from: Subscription,
  on: Subscription.definition.events,
}) {}

export const OutboundEventsLive = OutboundEvents.toLayer(
  Effect.sync(() =>
    Effect.fn("Paykit.Outbound.react")(function* ({ key, event, envelope }) {
      // Resolved per event, not while the layer is built: the `Outbound`
      // service is provided beside the model, in the host's runtime context.
      const outbound = yield* Effect.serviceOption(Outbound);

      if (Option.isNone(outbound)) return;
      const { endpoints, deliver } = outbound.value;

      if (endpoints.length === 0) return;

      const body = JSON.stringify({
        account: key.id,
        event,
        envelope: {
          stream: envelope.stream,
          seq: envelope.seq,
          at: envelope.at.epochMilliseconds,
          commandId: envelope.commandId,
          correlationId: envelope.correlationId,
        },
      });

      const timestamp = yield* Clock.currentTimeMillis;
      const idempotencyKey = `${key.id}:${envelope.seq}`;

      for (const endpoint of endpoints) {
        const signature = yield* outboundSignature({
          secret: endpoint.secret,
          timestamp,
          body,
        });

        yield* deliver({
          endpoint,
          body,
          idempotencyKey,
          headers: {
            "content-type": "application/json",
            "x-paykit-signature": signature,
            "x-paykit-idempotency-key": idempotencyKey,
            "x-paykit-event": event._tag,
          },
        }).pipe(
          // Retry the transport before leaving the event to the platform's
          // at-least-once redelivery. The key is stable, so a receiver dedupes
          // the retries and the redelivery alike.
          Effect.retry({ schedule: Schedule.exponential("25 millis"), times: 3 }),
          Effect.orDie,
        );
      }
    }),
  ),
);
