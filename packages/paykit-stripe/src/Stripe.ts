import {
  PaymentDeclined,
  PaymentsStripe,
  type MoneyProvider,
  type Price,
  type StripeBindings,
  type StripeTier,
  type StripeUsagePrice,
  type TierKind,
  type UsageLine,
  unitPriceKey,
} from "@potion.run/paykit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { distilledStripeClient } from "./StripeClient.ts";
import { stripeWebhook } from "./Webhooks.ts";

/** Where a tier lives in Stripe, and the price the catalog states. */
export type { StripeTier, StripeUsagePrice };

/**
 * The Stripe calls this package makes, as an interface so a test can stand in.
 * The error channel is paykit's `PaymentDeclined`, so the adapter and the model
 * never learn a Stripe error class.
 */
export interface StripeClient {
  /** A hosted Checkout Session for one price, tagged with its tier. */
  readonly createCheckoutSession: (request: {
    /** The base price first, then one metered price per billable feature. */
    readonly priceIds: ReadonlyArray<string>;
    readonly tier: string;
    /** A subscription opens a period; a one-off pack is a single payment. */
    readonly kind: TierKind;
    readonly customerExternalId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentDeclined>;
  /** A billing portal session, which is Stripe's way into the customer portal. */
  readonly createBillingPortalSession: (request: {
    readonly customerExternalId: string;
    readonly returnUrl: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentDeclined>;
  /**
   * Bill one amount on its own: an invoice with a single line item, finalized
   * so Stripe attempts the card. This is what collects a mid-cycle proration;
   * `invoice.paid` or `invoice.payment_failed` arrives later and the model
   * records it.
   */
  readonly createInvoice: (request: {
    readonly customerExternalId: string;
    readonly amount: number;
    readonly currency: string;
    readonly description: string;
  }) => Effect.Effect<{ readonly invoiceId: string }, PaymentDeclined>;
  /**
   * Resolve a tier's lookup key to the price that answers for it now. A price is
   * replaced when its amount changes, so the key is the stable handle and the id
   * is not.
   */
  readonly resolvePrice?: (lookupKey: string) => Effect.Effect<string, PaymentDeclined>;
  /** Refund a charge, fully or partially. */
  readonly createRefund?: (request: {
    readonly chargeId: string;
    readonly amount: number;
  }) => Effect.Effect<{}, PaymentDeclined>;
  /**
   * Send one meter event. `identifier` is the vendor idempotency key, and
   * `timestamp` is in seconds since the epoch, as Stripe's API expects.
   */
  readonly reportUsage?: (request: {
    readonly eventName: string;
    readonly customerExternalId: string;
    readonly quantity: number;
    readonly identifier: string;
    readonly timestamp: number;
  }) => Effect.Effect<{}, PaymentDeclined>;
}

/** What `Stripe()` needs to stand up a processor. */
export interface StripeProps {
  /** The Stripe secret key. Redacted, because it is a secret. */
  readonly secretKey: Redacted.Redacted<string>;
  /** Override the API base URL, for a proxy or a local Stripe. */
  readonly apiBaseUrl?: string;
  /** The app's origin: checkout returns here. */
  readonly origin: string;
  /** Tier → Stripe price, and the price the catalog already states. */
  readonly tiers?: Readonly<Record<string, StripeTier>>;
  /**
   * Feature → meter event name, from `StripePrices`. The meter is what the
   * closing period's billable units are sent to; without it the provider
   * declares no `usage` capability.
   */
  readonly meters?: Readonly<Record<string, string>>;
  /** Where a completed checkout returns to. Defaults to `/welcome`. */
  readonly successPath?: string;
  /** Where an abandoned checkout returns to. Defaults to `/pricing`. */
  readonly cancelPath?: string;
  /** Where the portal returns to. Defaults to `/billing`. */
  readonly billingPath?: string;
  /** What a proration line says. Defaults to `Plan change`. */
  readonly invoiceDescription?: string;
  /**
   * The endpoint's signing secret. With it, the provider carries the decoder,
   * so a deployment wires the tier mapping and the secret once.
   */
  readonly webhookSecret?: Redacted.Redacted<string>;
  /** How old a signed delivery may be. Stripe's own default is five minutes. */
  readonly webhookToleranceSeconds?: number;
  /**
   * The Stripe calls, for a test or an embedding. Omitted in a deployment: the
   * distilled client is built from `secretKey`.
   */
  readonly client?: StripeClient;
}

const declined = (op: string, cause: unknown): PaymentDeclined =>
  new PaymentDeclined({
    provider: "stripe",
    code: "stripe_error",
    message: `${op} failed: ${String((cause as { message?: unknown })?.message ?? cause)}`,
  });

/** Where a checkout, the portal and an invoice send the buyer back to. */
export interface StripeOrigin {
  readonly origin: string;
  readonly successPath?: string;
  readonly cancelPath?: string;
  readonly billingPath?: string;
  readonly invoiceDescription?: string;
  /** Feature → meter event name, from `StripePrices`. */
  readonly meters?: Readonly<Record<string, string>>;
}

/**
 * Map the distilled client onto paykit's `StripeBindings`.
 *
 * Every op the client implements becomes a declared capability, and the ones it
 * does not are left out rather than stubbed: paykit answers
 * `ProviderCapabilityMissing` for those, which is a refusal a caller can see.
 */
export const stripeClientBindings = (
  client: StripeClient,
  where: StripeOrigin,
): { readonly bindings: StripeBindings } => {
  const success = `${where.origin}${where.successPath ?? "/welcome"}`;
  const cancel = `${where.origin}${where.cancelPath ?? "/pricing"}`;
  const billing = `${where.origin}${where.billingPath ?? "/billing"}`;
  const bindings: StripeBindings = {
    createCheckoutSession: ({ account, tier, priceIds, kind }) =>
      client
        .createCheckoutSession({
          priceIds,
          tier,
          kind,
          customerExternalId: account,
          successUrl: success,
          cancelUrl: cancel,
        })
        .pipe(
          Effect.mapError((cause) => declined("createCheckoutSession", cause)),
          Effect.map((session) => ({ url: session.url })),
        ),
    createCustomerSession: ({ account }) =>
      client.createBillingPortalSession({ customerExternalId: account, returnUrl: billing }).pipe(
        Effect.mapError((cause) => declined("createBillingPortalSession", cause)),
        Effect.map((session) => ({ url: session.url })),
      ),
    createInvoice: ({ account, amount, currency }) =>
      client
        .createInvoice({
          customerExternalId: account,
          amount,
          currency,
          description: where.invoiceDescription ?? "Plan change",
        })
        .pipe(
          Effect.mapError((cause) => declined("createInvoice", cause)),
          Effect.map((invoice) => ({ invoiceId: invoice.invoiceId })),
        ),
    ...(client.resolvePrice === undefined
      ? {}
      : {
          resolvePrice: (lookupKey: string) =>
            client.resolvePrice!(lookupKey).pipe(
              Effect.mapError((cause) => declined("resolvePrice", cause)),
            ),
        }),
    ...(client.createRefund === undefined
      ? {}
      : {
          createRefund: ({ chargeId, amount }: { chargeId: string; amount: number }) =>
            client.createRefund!({ chargeId, amount }).pipe(
              Effect.mapError((cause) => declined("createRefund", cause)),
            ),
        }),
    ...(client.reportUsage === undefined || where.meters === undefined
      ? {}
      : {
          reportUsage: ({
            account,
            periodStart: _periodStart,
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
                      provider: "stripe",
                      code: "meter_not_configured",
                      message: `no Stripe meter for ${line.feature}`,
                    }),
                  );
                }
                return client.reportUsage!({
                  eventName,
                  customerExternalId: account,
                  quantity: line.quantity,
                  // The period plus the account, feature and price. Two accounts
                  // can close the same period, and one period can record a
                  // feature at two prices after a mid-period change: without the
                  // price in the key the second line is a redelivery of the
                  // first and its units never arrive.
                  identifier: `${commandId}:${account}:${line.feature}:${unitPriceKey(line.unitPrice)}`,
                  timestamp: Math.floor(DateTime.toEpochMillis(periodEnd) / 1000),
                }).pipe(
                  Effect.as({}),
                  Effect.mapError((cause) => declined("reportUsage", cause)),
                );
              },
              { concurrency: 1 },
            ).pipe(Effect.as({})),
        }),
  };
  return { bindings };
};

/**
 * Stripe as a processor, ready for `Paykit.Stack`.
 *
 * One call, no bindings to wire: `Stripe()` returns the `Provider` the catalog
 * needs, with the tier → price mapping and the price the catalog states, so
 * `Stack` can refuse a mapping that disagrees at deploy time.
 *
 * It moves money; paykit keeps the entitlement, and `check()` answers from
 * paykit's own read model rather than from anything read back out of Stripe.
 *
 * ### Selling a tier with Stripe
 * **Example:** A processor behind the catalog
 * ```typescript
 * const stripe = Stripe({
 *   secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
 *   origin: "https://app.example.com",
 *   tiers: { pro: { price: proPrice, priceId: "price_123" } },
 * });
 *
 * yield* Paykit.Stack("Billing", { providers: [stripe], catalog });
 * ```
 *
 * @primitive
 */
export const Stripe = (props: StripeProps): MoneyProvider<"processor"> => {
  const client =
    props.client ??
    distilledStripeClient({
      secretKey: props.secretKey,
      ...(props.apiBaseUrl === undefined ? {} : { apiBaseUrl: props.apiBaseUrl }),
    });
  const webhook =
    props.webhookSecret === undefined
      ? undefined
      : {
          provider: "stripe",
          decode: stripeWebhook({
            secret: props.webhookSecret,
            ...(props.tiers === undefined ? {} : { tiers: props.tiers }),
            ...(props.webhookToleranceSeconds === undefined
              ? {}
              : { toleranceSeconds: props.webhookToleranceSeconds }),
          }),
        };
  return PaymentsStripe({
    ...stripeClientBindings(client, props),
    ...(props.tiers === undefined ? {} : { tiers: props.tiers }),
    ...(webhook === undefined ? {} : { webhook }),
  });
};

/** The price a tier is sold at, or `null` when Stripe has no mapping for it. */
export const stripePriceOf = (props: Pick<StripeProps, "tiers">, tier: string): Price | null =>
  props.tiers?.[tier]?.price ?? null;
