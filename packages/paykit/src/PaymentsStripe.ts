import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PaymentDeclined,
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
  type PaymentCapability,
  type PaymentError,
  type MoneyProvider,
} from "./Payments.ts";
import type { Price } from "./Tier.ts";
import type { PaymentsWebhook } from "./Webhooks.ts";

/** The `@alchemy.run/stripe` bindings paykit consumes. */
export interface StripeBindings {
  readonly createCheckoutSession: (args: {
    readonly account: string;
    readonly tier: string;
    readonly priceId: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  readonly createCustomerSession: (args: {
    readonly account: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  /**
   * Optional: bill an amount on its own, which is how a mid-cycle proration is
   * collected. `@alchemy.run/stripe` ships no invoice binding, so a caller that
   * brings only those bindings declares no `invoice` capability.
   */
  readonly createInvoice?: (args: {
    readonly account: string;
    readonly amount: number;
    readonly currency: string;
  }) => Effect.Effect<{ readonly invoiceId: string }, PaymentError>;
  /** Optional: `@alchemy.run/stripe` ships no refund binding, so it is absent there. */
  readonly createRefund?: (args: {
    readonly chargeId: string;
    readonly amount: number;
  }) => Effect.Effect<{}, PaymentError>;
  /** Optional: write the tier into Stripe entitlements. Never read back. */
  readonly syncTier?: (args: {
    readonly account: string;
    readonly tier: string;
  }) => Effect.Effect<{}, PaymentError>;
}

/** Where a tier lives in Stripe, and the same price the catalog states. */
export interface StripeTier {
  readonly price: Price;
  readonly priceId: string;
}

export interface StripeProps {
  /**
   * How this provider reports a payment, when the deployment has a signing
   * secret for it. `Stack` records whether one is present.
   */
  readonly webhook?: PaymentsWebhook;
  readonly bindings: StripeBindings;
  readonly tiers?: Readonly<Record<string, StripeTier>>;
}

/**
 * The two Stripe calls this adapter makes, as `@alchemy.run/stripe` exposes
 * them. The error channels are the vendor's own, as parameters rather than
 * `unknown`: the adapter maps whatever Stripe raises into a
 * `PaymentDeclined`, so paykit's failure channel stays typed.
 */
export interface StripeBindingSource<CheckoutError, PortalError> {
  /** `yield* Stripe.CreateCheckoutSession()` from `@alchemy.run/stripe`. */
  readonly createCheckoutSession: (request: {
    readonly mode: "subscription";
    readonly line_items: ReadonlyArray<{ readonly price: string; readonly quantity: number }>;
    readonly customer: string;
    readonly success_url: string;
    readonly cancel_url: string;
  }) => Effect.Effect<{ readonly url: string }, CheckoutError>;
  /** `yield* Stripe.CreateBillingPortalSession()` from `@alchemy.run/stripe`. */
  readonly createBillingPortalSession: (request: {
    readonly customer: string;
    readonly return_url: string;
  }) => Effect.Effect<{ readonly url: string }, PortalError>;
}

/** Where a checkout and the portal send the buyer back to. */
export interface StripeOrigin {
  readonly origin: string;
  /** The path a completed checkout returns to. Defaults to `/welcome`. */
  readonly successPath?: string;
  /** The path an abandoned checkout returns to. Defaults to `/pricing`. */
  readonly cancelPath?: string;
  /** The path the portal returns to. Defaults to `/billing`. */
  readonly billingPath?: string;
}

const declined = (op: string, cause: unknown): PaymentDeclined =>
  new PaymentDeclined({
    provider: "stripe",
    code: "stripe_error",
    message: `${op} failed: ${String((cause as { message?: unknown })?.message ?? cause)}`,
  });

/**
 * Map `@alchemy.run/stripe`'s bindings onto the `Payments` port, so a user
 * writes the account's two calls and paykit does the rest.
 *
 * `@alchemy.run/stripe` is the vendor package for a caller that already has it.
 * `@potion.run/paykit-stripe` is the one-call path: it builds its client on
 * `@distilled.cloud/stripe` and returns the provider, so nothing else has to be
 * wired. This adapter is the port mapping under both.
 *
 * `refund` and `invoice` are absent from `@alchemy.run/stripe`, so a provider
 * built from those bindings does not declare them, and asking for one fails with
 * `ProviderCapabilityMissing` rather than pretending to decline a card.
 *
 * ### Wiring the Worker's bindings
 * **Example:** Stripe behind the port
 * ```typescript
 * const stripe = Paykit.Stripe({
 *   ...Paykit.stripeBindings(
 *     {
 *       createCheckoutSession: yield* Stripe.CreateCheckoutSession(),
 *       createBillingPortalSession: yield* Stripe.CreateBillingPortalSession(),
 *     },
 *     { origin: "https://app.example.com" },
 *   ),
 *   tiers: { pro: { price: proPrice, priceId: proPriceId } },
 * });
 * ```
 *
 * @primitive
 */
export const stripeBindings = <CheckoutError, PortalError>(
  source: StripeBindingSource<CheckoutError, PortalError>,
  where: StripeOrigin,
): Omit<StripeProps, "tiers"> => {
  const success = `${where.origin}${where.successPath ?? "/welcome"}`;
  const cancel = `${where.origin}${where.cancelPath ?? "/pricing"}`;
  const billing = `${where.origin}${where.billingPath ?? "/billing"}`;
  return {
    bindings: {
      createCheckoutSession: ({ account, priceId }) =>
        source
          .createCheckoutSession({
            mode: "subscription",
            line_items: [{ price: priceId, quantity: 1 }],
            customer: account,
            success_url: success,
            cancel_url: cancel,
          })
          .pipe(
            Effect.mapError((cause) => declined("createCheckoutSession", cause)),
            Effect.map((session) => ({ url: session.url })),
          ),
      createCustomerSession: ({ account }) =>
        source.createBillingPortalSession({ customer: account, return_url: billing }).pipe(
          Effect.mapError((cause) => declined("createBillingPortalSession", cause)),
          Effect.map((session) => ({ url: session.url })),
        ),
      // `createRefund` is left out on purpose: `@alchemy.run/stripe` ships no
      // refund binding, and a missing capability is `ProviderCapabilityMissing`
      // at the port rather than a fabricated decline here.
    },
  };
};

/**
 * A Stripe processor. It moves money; paykit keeps the entitlement. The price
 * the catalog states is the price Stripe charges, checked by `Stack`.
 */
export const PaymentsStripe = (props: StripeProps): MoneyProvider<"processor"> => {
  const capabilities: ReadonlySet<PaymentCapability> = new Set<PaymentCapability>([
    "checkout",
    "portal",
    ...(props.bindings.createInvoice === undefined ? [] : (["invoice"] as const)),
    ...(props.bindings.createRefund === undefined ? [] : (["refund"] as const)),
    ...(props.bindings.syncTier === undefined ? [] : (["syncTier"] as const)),
  ]);
  const missing = (op: string) =>
    Effect.fail(new ProviderCapabilityMissing({ provider: "stripe", op }));

  const service = Payments.toLayer(
    Effect.succeed({
      createCheckout: ({ account, tier }: { account: string; tier: string }) => {
        const mapped = props.tiers?.[tier];
        if (mapped === undefined) {
          return Effect.fail(
            new PaymentDeclined({
              provider: "stripe",
              code: "price_not_configured",
              message: `no Stripe price for ${tier}`,
            }),
          );
        }
        return props.bindings.createCheckoutSession({ account, tier, priceId: mapped.priceId });
      },
      createInvoice: ({
        account,
        amount,
        currency,
      }: {
        account: string;
        amount: number;
        currency: string;
      }) =>
        props.bindings.createInvoice === undefined
          ? missing("createInvoice")
          : props.bindings.createInvoice({ account, amount, currency }),
      refund: ({ chargeId, amount }: { chargeId: string; amount: number }) =>
        props.bindings.createRefund === undefined
          ? missing("refund")
          : props.bindings.createRefund({ chargeId, amount }),
      createPortal: ({ account }: { account: string }) =>
        props.bindings.createCustomerSession({ account }),
      syncTier: ({ account, tier }: { account: string; tier: string }) =>
        props.bindings.syncTier === undefined
          ? missing("syncTier")
          : props.bindings.syncTier({ account, tier }),
    }),
  );
  const payments = Layer.merge(
    service,
    Layer.succeed(PaymentsProvider, { name: "stripe", capabilities }),
  );

  const prices = Object.fromEntries(
    Object.entries(props.tiers ?? {}).map(([tier, mapped]) => [tier, mapped.price]),
  );

  return {
    name: "stripe",
    kind: "processor",
    capabilities,
    payments,
    ...(Object.keys(prices).length === 0 ? {} : { prices }),
    ...(props.webhook === undefined ? {} : { webhook: props.webhook }),
  };
};
