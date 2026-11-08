import * as Stripe from "@distilled.cloud/stripe";
import {
  CreateBillingPortalSession,
  GetPrices,
  CreateBillingMeterEvent,
  CreateCheckoutSession,
  CreateInvoice,
  CreateInvoiceFinalize,
  CreateInvoiceitem,
  CreatePaymentIntent,
  CreateRefund,
  GetSubscription,
  UpdateSubscription,
} from "@distilled.cloud/stripe/stripe";
import { PaymentDeclined } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { StripeClient } from "./Stripe.ts";

/** What a deployment hands the Stripe client. */
export interface StripeClientConfig {
  /** The secret key. A secret, so it arrives redacted. */
  readonly secretKey: Redacted.Redacted<string>;
  /** Override the API base URL, for a proxy or a local Stripe. */
  readonly apiBaseUrl?: string;
}

/** Stripe's own host. A test key and a live key both point here. */
export const STRIPE_API_BASE_URL = "https://api.stripe.com";

/**
 * The `@distilled.cloud/stripe` client behind paykit's calls.
 *
 * Every op needs Stripe's credentials, protocol and an HTTP client in context,
 * so the whole set is provided once here rather than by each caller. The
 * `@distilled.cloud/stripe` types are the vendor's: a field renamed upstream is
 * a compile error here, not a silently dropped argument.
 */
export const distilledStripeClient = (config: StripeClientConfig): StripeClient => {
  const apiBaseUrl = config.apiBaseUrl ?? STRIPE_API_BASE_URL;

  /** A vendor failure is a declined payment the model can record. */
  // SAFETY: a thrown value is untyped; this reads the one field a payment error reports and falls back to `String(cause)`.
  const declined = (op: string) => (cause: unknown) =>
    new PaymentDeclined({
      provider: "stripe",
      code: "stripe_error",
      message: `${op} failed: ${String((cause as { message?: unknown })?.message ?? cause)}`,
    });

  const live = Layer.mergeAll(
    Stripe.credentials({ apiKey: config.secretKey, apiBaseUrl }),
    Stripe.StripeProtocol,
    FetchHttpClient.layer,
  );

  return {
    createCheckoutSession: (request) =>
      CreateCheckoutSession({
        // A one-off pack is a single payment; a subscription repeats. Stripe
        // rejects `payment` for a recurring price, so the catalog's one-off
        // tiers must be provisioned with a one-time price.
        mode: request.kind === "one_off" ? "payment" : "subscription",
        // The base price plus every metered price on the same subscription.
        line_items: request.priceIds.map((price) => ({ price, quantity: 1 })),
        customer: request.customerExternalId,
        client_reference_id: request.customerExternalId,
        // The tier travels on the session, so the webhook does not have to
        // read the price back or grep a line item to know what was bought.
        metadata: { tier: request.tier },
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
      }).pipe(
        Effect.map((session) => ({ url: String(session.url) })),
        Effect.mapError(declined("createCheckoutSession")),
        Effect.provide(live),
      ),
    createBillingPortalSession: (request) =>
      CreateBillingPortalSession({
        customer: request.customerExternalId,
        return_url: request.returnUrl,
      }).pipe(
        Effect.map((session) => ({ url: String(session.url) })),
        Effect.mapError(declined("createBillingPortalSession")),
        Effect.provide(live),
      ),
    // Stripe bills an arbitrary amount as an invoice with one line item. It is
    // created as a draft, given the proration's amount, then finalized with
    // `auto_advance`, which makes Stripe attempt the card. A decline surfaces
    // as `invoice.payment_failed`, which the model records as a failed charge
    // and dunning chases; the invoice id is what the log keeps.
    createInvoice: (request) =>
      Effect.gen(function* () {
        // A retry of the same change must land on the same draft, line item and
        // finalization, so each call gets its own key derived from the change.
        // Sharing one key across all three would be an idempotency conflict:
        // Stripe keys a request by its key and its parameters.
        const idempotent = <A, E, R>(step: string, effect: Effect.Effect<A, E, R>) =>
          request.commandId === undefined
            ? effect
            : effect.pipe(
                Stripe.withRequestOptions({
                  idempotencyKey: `${request.commandId}:${step}`,
                }),
              );

        const draft = yield* idempotent(
          "draft",
          CreateInvoice({
            customer: request.customerExternalId,
            collection_method: "charge_automatically",
            auto_advance: false,
          }),
        );

        if (draft.id === undefined) {
          return yield* new PaymentDeclined({
            provider: "stripe",
            code: "stripe_error",
            message: "createInvoice returned an invoice with no id",
          });
        }

        yield* idempotent(
          "item",
          CreateInvoiceitem({
            customer: request.customerExternalId,
            invoice: draft.id,
            amount: request.amount,
            currency: request.currency,
            description: request.description,
          }),
        );

        const finalized = yield* idempotent(
          "finalize",
          CreateInvoiceFinalize({
            invoice: draft.id,
            auto_advance: true,
          }),
        );

        if (finalized.id === undefined) {
          return yield* new PaymentDeclined({
            provider: "stripe",
            code: "stripe_error",
            message: "createInvoice finalized an invoice with no id",
          });
        }

        return { invoiceId: finalized.id };
      }).pipe(Effect.mapError(declined("createInvoice")), Effect.provide(live)),
    resolvePrice: (lookupKey) =>
      GetPrices({ lookup_keys: [lookupKey], active: true, limit: 1 }).pipe(
        Effect.flatMap((prices) => {
          const price = prices.data[0];

          return price?.id === undefined
            ? Effect.fail(
                new PaymentDeclined({
                  provider: "stripe",
                  code: "price_not_configured",
                  message: `no active price for lookup key ${lookupKey}`,
                }),
              )
            : Effect.succeed(price.id);
        }),
        Effect.mapError((cause) => declined("resolvePrice")(cause)),
        Effect.provide(live),
      ),
    createRefund: (request) =>
      CreateRefund({ charge: request.chargeId, amount: request.amount }).pipe(
        // The operator's dedupe key is the vendor's idempotency key, so a retry
        // is the refund Stripe already took.
        (refund) =>
          request.commandId === undefined
            ? refund
            : refund.pipe(Stripe.withRequestOptions({ idempotencyKey: request.commandId })),
        Effect.provide(live),
        Effect.mapError(declined("createRefund")),
        Effect.flatMap((refund) =>
          refund.id === undefined
            ? Effect.fail(
                new PaymentDeclined({
                  provider: "stripe",
                  code: "stripe_error",
                  message: "createRefund returned a refund with no id",
                }),
              )
            : Effect.succeed({ refundId: refund.id }),
        ),
      ),
    // Off-session: confirm the intent against the customer's default payment
    // method, so the money is taken at the crossing rather than on Stripe's own
    // collection schedule. The crossing's id is the idempotency key, so a retry
    // is the intent it already created.
    charge: (request) =>
      CreatePaymentIntent({
        customer: request.customerExternalId,
        amount: request.amount,
        currency: request.currency,
        confirm: true,
        off_session: true,
        description: request.description,
        ...(request.commandId === undefined
          ? {}
          : { metadata: { paykit_command_id: request.commandId } }),
      }).pipe(
        Effect.provide(live),
        Effect.mapError(declined("charge")),
        Effect.flatMap((intent) =>
          intent.id === undefined
            ? Effect.fail(
                new PaymentDeclined({
                  provider: "stripe",
                  code: "stripe_error",
                  message: "charge returned a payment intent with no id",
                }),
              )
            : Effect.succeed({ chargeId: intent.id }),
        ),
      ),
    // Set the seat quantity on the subscription item whose price is the seat
    // price. `always_invoice` makes Stripe invoice the proration now; `none`
    // leaves it to the next renewal. The change's id is the idempotency key,
    // so a retry sets the same quantity rather than a second change.
    setSubscriptionItemQuantity: (request) =>
      Effect.gen(function* () {
        const subscription = yield* GetSubscription({
          subscription_exposed_id: request.subscription,
        });

        const item = subscription.items.data.find(
          (candidate) => candidate.price?.id === request.priceId,
        );

        if (item === undefined) {
          return yield* new PaymentDeclined({
            provider: "stripe",
            code: "subscription_item_missing",
            message: `subscription ${request.subscription} has no item for ${request.priceId}`,
          });
        }

        const update = UpdateSubscription({
          subscription_exposed_id: request.subscription,
          items: [{ id: item.id, quantity: request.quantity }],
          proration_behavior: request.proration === "immediate" ? "always_invoice" : "none",
        });

        const updated = yield* request.commandId === undefined
          ? update
          : update.pipe(Stripe.withRequestOptions({ idempotencyKey: request.commandId }));

        const latest = updated.latest_invoice;
        const invoiceId = typeof latest === "string" ? latest : latest?.id;

        return invoiceId === undefined ? {} : { invoiceId };
      }).pipe(Effect.mapError(declined("setSubscriptionItemQuantity")), Effect.provide(live)),
    // One meter event per feature, carrying the billable quantity. Stripe's
    // `identifier` is the idempotency contract: the close's period id plus the
    // feature, so a retry is the same event rather than a second quantity.
    reportUsage: (request) =>
      CreateBillingMeterEvent({
        event_name: request.eventName,
        identifier: request.identifier,
        timestamp: request.timestamp,
        payload: {
          stripe_customer_id: request.customerExternalId,
          value: String(request.quantity),
        },
      }).pipe(Effect.as({}), Effect.mapError(declined("reportUsage")), Effect.provide(live)),
  };
};

/** The HTTP client a Worker uses; named so a test can see what is provided. */
export const StripeHttp = FetchHttpClient.layer;

/** The base URL resolved from a config, or `https://api.stripe.com`. */
export const stripeBaseUrl = (config: { readonly apiBaseUrl?: string }): string =>
  config.apiBaseUrl ?? STRIPE_API_BASE_URL;
