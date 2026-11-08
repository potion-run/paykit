import * as Polar from "@distilled.cloud/polar";
import { PaymentDeclined } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { PolarClient, PolarServer } from "./Polar.ts";

/** What a deployment hands the Polar client. */
export interface PolarClientConfig {
  /** The Polar access token. A secret, so it arrives redacted. */
  readonly accessToken: Redacted.Redacted<string>;
  /** Which Polar this token belongs to. Defaults to `production`. */
  readonly server?: PolarServer;
  /** Override the API base URL, for a proxy or a local Polar. */
  readonly baseUrl?: string;
}

/** Polar's own host per server. Sandbox data is not production's. */
export const POLAR_BASE_URL: Readonly<Record<PolarServer, string>> = {
  production: "https://api.polar.sh",
  sandbox: "https://sandbox-api.polar.sh",
};

/**
 * The `@distilled.cloud/polar` client behind paykit's three calls.
 *
 * Every op needs Polar's credentials, protocol and an HTTP client in context,
 * so the whole set is provided once here rather than by each caller. The
 * `@distilled.cloud/polar` types are the vendor's: a field renamed upstream is a
 * compile error here, not a silently dropped argument.
 *
 * `reason` is Polar's enum for why a refund happened; a checkout that never
 * completed is the honest one for an abandoned purchase.
 */
export const distilledPolarClient = (config: PolarClientConfig): PolarClient => {
  const baseUrl = config.baseUrl ?? POLAR_BASE_URL[config.server ?? "production"];

  // Credentials, the protocol and an HTTP client, provided once: every Polar
  // op needs all three, and a Worker has no `process.env` to read a key from.
  /** A vendor failure is a declined payment the model can record. */
  // SAFETY: a thrown value is untyped; the SDK's metadata type only declares the two keys it knows, while Polar accepts any.
  const declined = (op: string) => (cause: unknown) =>
    new PaymentDeclined({
      provider: "polar",
      code: "polar_error",
      message: `${op} failed: ${String((cause as { message?: unknown })?.message ?? cause)}`,
    });

  const live = Layer.mergeAll(
    Polar.fromApiKey({ apiKey: config.accessToken, apiBaseUrl: baseUrl }),
    Polar.PolarProtocol,
    FetchHttpClient.layer,
  );

  // SAFETY: a thrown value is untyped; the SDK's metadata type only declares the two keys it knows, while Polar accepts any.
  return {
    createCheckoutSession: (request) =>
      Polar.checkoutsCreate({
        // Polar sells a product, not a mode: a one-off tier is mapped to a
        // one-time product, so the `kind` only documents the intent here.
        products: [request.productId],
        external_customer_id: request.customerExternalId,
        success_url: request.successUrl,
        return_url: request.returnUrl,
      }).pipe(
        Effect.map((checkout) => ({ url: String(checkout.url) })),
        Effect.mapError(declined("createCheckoutSession")),
        Effect.provide(live),
      ),
    createCustomerSession: (request) =>
      Polar.customerSessionsCreate({
        body: {
          external_customer_id: request.customerExternalId,
          return_url: request.returnUrl,
        },
      }).pipe(
        Effect.map((session) => ({ url: String(session.customer_portal_url) })),
        Effect.mapError(declined("createCustomerSession")),
        Effect.provide(live),
      ),
    // Polar bills an arbitrary amount as a one-off order: create it as a draft
    // with the proration's amount, then finalize, which attempts the off-session
    // charge against the customer's saved payment method. A decline leaves the
    // order in `draft` and arrives here as a vendor error, which is what the
    // model records as a failed charge.
    createInvoice: (request) =>
      Effect.gen(function* () {
        // Polar has no idempotency key for an order. A retry can therefore open
        // a second draft; the order's metadata carries the change id so an
        // operator can recognize the pair, and the caller still records once.
        const customer = yield* Polar.customersGetExternal({
          external_id: request.customerExternalId,
        });

        const draft = yield* Polar.ordersCreate({
          customer_id: customer.id,
          product_id: request.productId,
          amount: request.amount,
          currency: request.currency,
          description: request.description,
          ...(request.commandId === undefined
            ? {}
            : { metadata: { paykit_command_id: request.commandId } }),
        });

        const paid = yield* Polar.ordersFinalize({ id: draft.id });

        return { invoiceId: paid.id };
      }).pipe(Effect.mapError(declined("createInvoice")), Effect.provide(live)),
    createRefund: (request) =>
      Polar.refundsCreate({
        order_id: request.orderId,
        amount: request.amount,
        reason: "customer_request",
      }).pipe(
        Effect.provide(live),
        Effect.mapError(declined("createRefund")),
        Effect.map((refund) => ({ refundId: refund.id })),
      ),
    // One event per feature. Polar's meter aggregates `metadata.units` with the
    // filter the deploy created, and `external_id` is the dedupe key: a
    // redelivered close is the same event rather than a second quantity.
    reportUsage: (request) =>
      Polar.eventsIngest({
        events: [
          {
            name: request.eventName,
            external_customer_id: request.externalCustomerId,
            external_id: request.externalId,
            timestamp: request.timestamp,
            // The SDK's metadata type only names `_cost` / `_llm`; Polar
            // accepts arbitrary keys, and the meter sums `metadata.units`.
            metadata: { units: request.quantity } as Polar.EventMetadataInput,
          },
        ],
      }).pipe(Effect.asVoid, Effect.mapError(declined("reportUsage")), Effect.provide(live)),
  };
};

/** The HTTP client a Worker uses; named so a test can see what is provided. */
export const PolarHttp = FetchHttpClient.layer;

/** A base URL resolved from a config, or the default for a server. */
export const polarBaseUrl = (config: {
  readonly server?: PolarServer;
  readonly baseUrl?: string;
}): string => config.baseUrl ?? POLAR_BASE_URL[config.server ?? "production"];
