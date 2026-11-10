import * as Stripe from "@distilled.cloud/stripe";
import {
  type StripeTier,
  type WebhookError,
  type WebhookEvent,
  type WebhookRequest,
  WebhookInvalid,
  WebhookSignatureInvalid,
} from "@potion.run/paykit";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** The only errors the webhook translation may return. */
export type StripeWebhookError = WebhookError;

/** A Stripe delivery: the body and the headers that signed it. */
export type StripeWebhookRequest = WebhookRequest;

/** What `stripeWebhook` needs: the signing secret and the tier → price map. */
export interface StripeWebhookProps {
  /**
   * The endpoint's signing secret. A Worker reads it from its environment and
   * passes a `Redacted`; `StripeBilling` passes the endpoint's secret attribute
   * as an `Output`, which the decoder resolves when a delivery needs it.
   */
  readonly secret: Redacted.Redacted<string> | Output.Output<Redacted.Redacted<string>, never>;
  /** Tier → Stripe price, the same map `Stripe()` was given. */
  readonly tiers?: Readonly<Record<string, StripeTier>>;
  /** How old a signed request may be. Stripe's own default is five minutes. */
  readonly toleranceSeconds?: number;
}

/** The fields of a Stripe event this translation reads. */
const EventData = Schema.Struct({
  object: Schema.Unknown,
});

/** The fields of `checkout.session` this translation reads. */
const CheckoutSession = Schema.Struct({
  /** The checkout session's own id, which is what a quote is keyed by. */
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  customer: Schema.optionalKey(Schema.NullOr(Schema.String)),
  client_reference_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  amount_total: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The payment intent is the charge a cancellation refunds. */
  payment_intent: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** One line of an invoice or a subscription: enough to find the price bought. */
const PricedLine = Schema.Struct({
  price: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
});

/** The fields of `invoice` and `subscription` this translation reads. */
const Billed = Schema.Struct({
  /** The invoice's or subscription's own id, which is what a quote is keyed by. */
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  customer: Schema.optionalKey(Schema.NullOr(Schema.String)),
  amount_paid: Schema.optionalKey(Schema.Int),
  /** The charge the invoice paid. */
  charge: Schema.optionalKey(Schema.NullOr(Schema.String)),
  currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lines: Schema.optionalKey(Schema.Struct({ data: Schema.Array(PricedLine) })),
  items: Schema.optionalKey(Schema.Struct({ data: Schema.Array(PricedLine) })),
});

const header = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }

  return undefined;
};

/**
 * Verify and translate one Stripe webhook into paykit's provider-neutral event.
 *
 * `stripeWebhook(props)` returns the function a `/webhooks/stripe` route calls:
 * the signature check is `@distilled.cloud/stripe`'s own `constructEvent`, then
 * the payload is decoded and answered as the `WebhookEvent` `handleWebhook`
 * already knows how to apply — or `none` for an event paykit does not model,
 * which the route answers 200 and ignores.
 *
 * The Stripe event id is the command id, so a redelivery replays rather than
 * activating, charging or cancelling twice.
 *
 * The tier comes from the price the buyer actually paid for — read in the
 * mapping, never invented: a price no tier maps keeps the account and drops the
 * tier rather than refusing the endpoint.
 *
 * ### Handling a Stripe webhook
 * **Example:** One route, one translation
 * ```typescript
 * const webhook = stripeWebhook({
 *   secret: yield* Config.redacted("STRIPE_WEBHOOK_SECRET"),
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
export const stripeWebhook = (
  props: StripeWebhookProps,
): ((
  request: StripeWebhookRequest,
) => Effect.Effect<Option.Option<WebhookEvent>, StripeWebhookError>) => {
  const byPrice = new Map(
    Object.entries(props.tiers ?? {}).map(([tier, mapped]) => [mapped.priceId, tier]),
  );

  const toleranceSeconds = props.toleranceSeconds ?? 300;

  return Effect.fn("Stripe.webhook")(function* (request: StripeWebhookRequest) {
    const signature = header(request.headers, "stripe-signature");

    if (signature === undefined) {
      return yield* new WebhookSignatureInvalid({
        provider: "stripe",
        reason: "missing Stripe-Signature header",
      });
    }

    const event = yield* Stripe.Webhooks.constructEvent({
      payload: request.body,
      signature,
      // A plain secret is the Worker's form. An Output is the deploy's: the
      // endpoint's attribute is not resolvable while the stack is declared, so
      // it is read when a delivery is actually verified.
      secret: Output.isOutput(props.secret)
        ? yield* Effect.map(yield* props.secret, Redacted.value)
        : Redacted.value(props.secret),
      toleranceSeconds,
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "StripeWebhookPayloadParseError"
          ? new WebhookInvalid({ event: "unknown", field: "payload" })
          : new WebhookSignatureInvalid({ provider: "stripe", reason: cause.message }),
      ),
    );

    const id = event.id ?? "";

    const data = yield* Schema.decodeUnknownEffect(EventData)(event.data).pipe(
      Effect.mapError(() => new WebhookInvalid({ event: id, field: "payload" })),
    );

    const invalid = (field: string) => new WebhookInvalid({ event: id, field });
    const none = Option.none<WebhookEvent>();

    /** A tier only when one of the given prices maps to it. */
    const tierOfPrice = (line: typeof PricedLine.Type): { readonly tier?: string } => {
      const price = line.price?.id;
      const tier = price === undefined ? undefined : byPrice.get(price);

      return tier === undefined ? {} : { tier };
    };

    switch (event.type) {
      case "checkout.session.completed": {
        const session = yield* Schema.decodeUnknownEffect(CheckoutSession)(data.object).pipe(
          Effect.mapError(() => invalid("payload")),
        );

        const account = session.client_reference_id ?? session.customer;

        if (account === null || account === undefined) return yield* invalid("account");
        const tier = session.metadata?.tier;
        const amount = session.amount_total;
        const currency = session.currency;

        return Option.some({
          id,
          provider: "stripe",
          kind: "checkout_completed",
          account,
          ...(session.id === null || session.id === undefined ? {} : { reference: session.id }),
          ...(tier === undefined ? {} : { tier }),
          ...(amount === null || amount === undefined ? {} : { amount }),
          ...(currency === null || currency === undefined ? {} : { currency }),
          ...(session.payment_intent === null || session.payment_intent === undefined
            ? {}
            : { chargeId: session.payment_intent }),
        });
      }

      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = yield* Schema.decodeUnknownEffect(Billed)(data.object).pipe(
          Effect.mapError(() => invalid("payload")),
        );

        const account = invoice.customer;

        if (account === null || account === undefined) return yield* invalid("account");
        const first = invoice.lines?.data[0];

        return Option.some({
          id,
          provider: "stripe",
          kind: event.type === "invoice.paid" ? "payment_succeeded" : "payment_failed",
          account,
          ...(invoice.id === null || invoice.id === undefined ? {} : { reference: invoice.id }),
          ...(first === undefined ? {} : tierOfPrice(first)),
          ...(invoice.amount_paid === undefined ? {} : { amount: invoice.amount_paid }),
          ...(invoice.currency === null || invoice.currency === undefined
            ? {}
            : { currency: invoice.currency }),
          ...(invoice.charge === null || invoice.charge === undefined
            ? {}
            : { chargeId: invoice.charge }),
          ...(event.type === "invoice.paid" ? {} : { reason: "invoice_payment_failed" }),
        });
      }

      case "customer.subscription.deleted": {
        const subscription = yield* Schema.decodeUnknownEffect(Billed)(data.object).pipe(
          Effect.mapError(() => invalid("payload")),
        );

        const account = subscription.customer;

        if (account === null || account === undefined) return yield* invalid("account");
        const first = subscription.items?.data[0];

        return Option.some({
          id,
          provider: "stripe",
          kind: "subscription_canceled",
          account,
          ...(subscription.id === null || subscription.id === undefined
            ? {}
            : { reference: subscription.id }),
          ...(first === undefined ? {} : tierOfPrice(first)),
        });
      }

      default:
        // Every other Stripe event is not a standing change: the route answers
        // 200 and records nothing.
        return none;
    }
  });
};
