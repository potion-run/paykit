import {
  PaymentDeclined,
  PaymentsPolar,
  type PolarBindings,
  type PolarTier,
  type MoneyProvider,
  type Price,
  type PlanKind,
  type UnitPrice,
  type UsageLine,
  unitPriceKey,
} from "@potion.run/paykit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { distilledPolarClient } from "./PolarClient.ts";
import { polarWebhook } from "./Webhooks.ts";

/** Where a tier lives in Polar, and the price the catalog states. */
export type { PolarTier, UnitPrice };

/** Which Polar the token belongs to. Sandbox products are not production's. */
export type PolarServer = "production" | "sandbox";

/**
 * The Polar calls this package makes, as an interface so a test can stand in.
 * The error channel is the vendor's own, as a parameter rather than `unknown`:
 * `polarBindings` maps whatever Polar raises into a `PaymentDeclined`, so
 * paykit's failure channel stays typed.
 */
export interface PolarClient {
  /** Create a checkout session for a product, for one customer. */
  readonly createCheckoutSession: (request: {
    readonly productId: string;
    readonly customerExternalId: string;
    readonly successUrl: string;
    readonly returnUrl: string;
    /** A subscription product opens a period; a one-off product does not. */
    readonly kind: PlanKind;
  }) => Effect.Effect<{ readonly url: string }, PaymentDeclined>;
  /** A customer session, which is Polar's way into the customer portal. */
  readonly createCustomerSession: (request: {
    readonly customerExternalId: string;
    readonly returnUrl: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentDeclined>;
  /**
   * A customer session where the customer adds or replaces a payment method,
   * with no purchase. Polar owns the portal, so this is the same call as
   * `createCustomerSession`; a client that cannot open one declares no `setup`
   * capability. Polar has no idempotency key for a customer session.
   */
  readonly createSetupSession?: (request: {
    readonly customerExternalId: string;
    readonly returnUrl: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentDeclined>;
  /**
   * Bill one amount on its own: a one-off order on the configured product,
   * finalized so Polar charges the customer's saved payment method. This is
   * what collects a mid-cycle proration.
   */
  readonly createInvoice: (request: {
    readonly customerExternalId: string;
    readonly productId: string;
    readonly amount: number;
    readonly currency: string;
    readonly description: string;
    /** Stable across retries. Polar has no idempotency key; a client may dedupe. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly invoiceId: string }, PaymentDeclined>;
  /** Refund a Polar order. */
  readonly createRefund: (request: {
    readonly orderId: string;
    readonly amount: number;
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly refundId: string }, PaymentDeclined>;
  /**
   * Set the subscription's seat count. Polar's count is one number on the
   * subscription, and the update is `next_period`: the local collector bills
   * an immediate proration as its own order.
   */
  readonly setSubscriptionSeats?: (request: {
    readonly subscription: string;
    readonly seats: number;
    readonly commandId: string;
  }) => Effect.Effect<{}, PaymentDeclined>;
  /**
   * Ingest one metered-usage event. `externalId` is the idempotency key; Polar
   * dedupes by it, so a retried close is the same event.
   */
  readonly reportUsage?: (request: {
    readonly eventName: string;
    readonly externalCustomerId: string;
    readonly quantity: number;
    readonly externalId: string;
    readonly timestamp: string;
  }) => Effect.Effect<unknown, PaymentDeclined>;
}

/** What `Polar()` needs to stand up a merchant of record. */
export interface PolarProps {
  /** The Polar access token. Redacted, because it is a secret. */
  readonly accessToken: string;
  /** Which Polar this token belongs to. Defaults to `production`. */
  readonly server?: PolarServer;
  /** Override the API base URL, for a proxy or a local Polar. */
  readonly baseUrl?: string;
  /** The app's origin: checkout returns here. */
  readonly origin: string;
  /** Tier → Polar product, and the price the catalog already states. */
  readonly tiers?: Readonly<Record<string, PolarTier>>;
  /**
   * Feature → meter event name, from `PolarPrices`. The meter is what the
   * closing period's billable units are sent to; without it the provider
   * declares no `usage` capability.
   */
  readonly meters?: Readonly<Record<string, string>>;
  /**
   * The id of the one-time product a proration is billed as. Without it the
   * provider declares no `invoice` capability, so `ChargeProration` fails with
   * `ProviderCapabilityMissing` rather than silently collecting nothing.
   */
  readonly invoiceProductId?: string;
  /** What the invoice line says. Defaults to `Plan change`. */
  readonly invoiceDescription?: string;
  /**
   * The webhook endpoint's signing secret. With it, the provider carries the
   * decoder, so a deployment wires the tier mapping and the secret once.
   */
  readonly webhookSecret?: Redacted.Redacted<string>;
  /** How old a signed delivery may be. Polar's spec recommends five minutes. */
  readonly webhookToleranceSeconds?: number;
  /** Where a completed checkout returns to. Defaults to `/welcome`. */
  readonly successPath?: string;
  /** Where the portal returns to. Defaults to `/billing`. */
  readonly billingPath?: string;
  /**
   * The Polar calls, for a test or an embedding. Omitted in a deployment: the
   * distilled client is built from `accessToken` and `server`.
   */
  readonly client?: PolarClient;
}

// SAFETY: a thrown value is untyped; an empty layer satisfies any service requirement, and the error formatter reads the one field it reports.
const declined = (op: string, cause: unknown): PaymentDeclined =>
  new PaymentDeclined({
    provider: "polar",
    code: "polar_error",
    message: `${op} failed: ${String((cause as { message?: unknown })?.message ?? cause)}`,
  });

/** Map the Polar client onto the `Payments` port's shape. */
export const polarBindings = (
  client: PolarClient,
  where: {
    readonly origin: string;
    readonly successPath?: string;
    readonly billingPath?: string;
    readonly invoiceProductId?: string;
    readonly invoiceDescription?: string;
    readonly meters?: Readonly<Record<string, string>>;
  },
): PolarBindings => {
  const success = `${where.origin}${where.successPath ?? "/welcome"}`;
  const billing = `${where.origin}${where.billingPath ?? "/billing"}`;

  return {
    createCheckoutSession: ({ account, productId, kind }) =>
      client
        .createCheckoutSession({
          productId,
          customerExternalId: account,
          successUrl: success,
          returnUrl: billing,
          kind,
        })
        .pipe(
          Effect.mapError((cause) => declined("createCheckoutSession", cause)),
          Effect.map((session) => ({ url: session.url })),
        ),
    createCustomerSession: ({ account }) =>
      client.createCustomerSession({ customerExternalId: account, returnUrl: billing }).pipe(
        Effect.mapError((cause) => declined("createCustomerSession", cause)),
        Effect.map((session) => ({ url: session.url })),
      ),
    ...(client.createSetupSession === undefined
      ? {}
      : {
          // Polar has no idempotency key for a customer session, so the port's
          // command id is accepted and not sent.
          createSetupSession: ({ account }: { account: string; commandId?: string }) =>
            client.createSetupSession!({
              customerExternalId: account,
              returnUrl: billing,
            }).pipe(
              Effect.mapError((cause) => declined("createSetupSession", cause)),
              Effect.map((session) => ({ url: session.url })),
            ),
        }),
    // No invoice product, no invoice capability: a proration charge that
    // silently collected nothing would be worse than a typed refusal.
    ...(where.invoiceProductId === undefined
      ? {}
      : {
          createInvoice: ({
            account,
            amount,
            currency,
            commandId,
          }: {
            account: string;
            amount: number;
            currency: string;
            commandId?: string;
          }) =>
            client
              .createInvoice({
                customerExternalId: account,
                productId: where.invoiceProductId!,
                amount,
                currency,
                description: where.invoiceDescription ?? "Plan change",
                ...(commandId === undefined ? {} : { commandId }),
              })
              .pipe(
                Effect.mapError((cause) => declined("createInvoice", cause)),
                Effect.map((invoice) => ({ invoiceId: invoice.invoiceId })),
              ),
        }),
    createRefund: ({ chargeId, amount, commandId }) =>
      client
        .createRefund({
          orderId: chargeId,
          amount,
          ...(commandId === undefined ? {} : { commandId }),
        })
        .pipe(
          Effect.mapError((cause) => declined("createRefund", cause)),
          Effect.map((refund) => ({ refundId: refund.refundId })),
        ),
    ...(client.setSubscriptionSeats === undefined
      ? {}
      : {
          setQuantity: ({
            subscription,
            seats,
            commandId,
          }: {
            subscription: string;
            seats: number;
            proration: "immediate" | "none";
            commandId: string;
          }) =>
            client.setSubscriptionSeats!({ subscription, seats, commandId }).pipe(
              Effect.mapError((cause) => declined("setSubscriptionSeats", cause)),
              Effect.map(() => ({})),
            ),
        }),
    ...(client.reportUsage === undefined || where.meters === undefined
      ? {}
      : {
          reportUsage: ({
            account,
            periodEnd,
            lines,
            commandId,
          }: {
            account: string;
            periodStart: DateTime.Utc;
            periodEnd: DateTime.Utc;
            lines: ReadonlyArray<UsageLine>;
            commandId: string;
          }) =>
            Effect.forEach(
              lines,
              (line) => {
                const eventName = where.meters?.[line.feature];

                if (eventName === undefined) {
                  return Effect.fail(
                    new PaymentDeclined({
                      provider: "polar",
                      code: "meter_not_configured",
                      message: `no Polar meter for ${line.feature}`,
                    }),
                  );
                }

                return client.reportUsage!({
                  eventName,
                  externalCustomerId: account,
                  quantity: line.quantity,
                  // The period plus the account, feature and price: two accounts
                  // closing one period must not collide, and one period can
                  // record a feature at two prices after a mid-period change.
                  externalId: `${commandId}:${account}:${line.feature}:${unitPriceKey(line.unitPrice)}`,
                  timestamp: DateTime.formatIso(periodEnd),
                }).pipe(
                  Effect.as({}),
                  Effect.mapError((cause) => declined("reportUsage", cause)),
                );
              },
              { concurrency: 1 },
            ).pipe(Effect.as({})),
        }),
  };
};

/**
 * Polar as a merchant of record, ready for `Paykit.BillingStack`.
 *
 * One call, no bindings to wire: `Polar()` returns the `Provider` the catalog
 * needs, with the tier → product mapping and the price the catalog states, so
 * `BillingStack` can refuse a mapping that disagrees at deploy time.
 *
 * It owns tax, receipts and payments; paykit keeps the entitlement. Polar's
 * benefits are written as a consequence of a tier change and never read back —
 * `check()` answers from paykit's own read model.
 *
 * Polar is the one vendor with no Alchemy package, which is why paykit publishes
 * this one. It is paykit-shaped on purpose: a general provider would need its
 * own users and release train to justify the same maintenance.
 *
 * ### Selling a product with Polar
 * **Example:** A merchant of record behind the catalog
 * ```typescript
 * const polar = Polar({
 *   accessToken: yield* Config.redacted("POLAR_ACCESS_TOKEN"),
 *   origin: "https://app.example.com",
 *   tiers: { pro: { price: proPrice, productId: "prod_123" } },
 * });
 *
 * yield* Paykit.BillingStack("Billing", { providers: [polar], catalog });
 * ```
 *
 * @primitive
 */
export const Polar = (props: PolarProps): MoneyProvider<"merchant_of_record"> => {
  const client =
    props.client ??
    distilledPolarClient({
      accessToken: Redacted.make(props.accessToken),
      ...(props.server === undefined ? {} : { server: props.server }),
      ...(props.baseUrl === undefined ? {} : { baseUrl: props.baseUrl }),
    });

  const webhook =
    props.webhookSecret === undefined
      ? undefined
      : {
          provider: "polar",
          decode: polarWebhook({
            secret: props.webhookSecret,
            ...(props.tiers === undefined ? {} : { tiers: props.tiers }),
            ...(props.webhookToleranceSeconds === undefined
              ? {}
              : { toleranceSeconds: props.webhookToleranceSeconds }),
          }),
        };

  return PaymentsPolar({
    bindings: polarBindings(client, props),
    ...(props.tiers === undefined ? {} : { tiers: props.tiers }),
    ...(webhook === undefined ? {} : { webhook }),
  });
};

/** The price a tier is sold at, or `null` when Polar has no mapping for it. */
export const polarPriceOf = (props: Pick<PolarProps, "tiers">, tier: string): Price | null =>
  props.tiers?.[tier]?.price ?? null;

/** A layer that provides nothing; kept so `Polar` composes with `Layer.mergeAll`. */
// SAFETY: a thrown value is untyped; an empty layer satisfies any service requirement, and the error formatter reads the one field it reports.
export const polarLayer = Layer.empty as Layer.Layer<never>;
