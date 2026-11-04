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

/** The Stripe calls this adapter consumes, supplied by a vendor package. */
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
   * Optional: resolve a tier's `lookupKey` to the price that answers for it
   * right now. Required to configure a tier by key instead of by id.
   */
  readonly resolvePrice?: (lookupKey: string) => Effect.Effect<string, PaymentError>;
  /**
   * Optional: bill an amount on its own, which is how a mid-cycle proration is
   * collected. A caller that cannot bill an amount on its own declares no
   * `invoice` capability.
   */
  readonly createInvoice?: (args: {
    readonly account: string;
    readonly amount: number;
    readonly currency: string;
  }) => Effect.Effect<{ readonly invoiceId: string }, PaymentError>;
  /** Optional: a caller that cannot refund declares no `refund` capability. */
  readonly createRefund?: (args: {
    readonly chargeId: string;
    readonly amount: number;
  }) => Effect.Effect<{}, PaymentError>;
}

/**
 * Where a tier lives in Stripe, and the same price the catalog states.
 *
 * A tier is configured by one of two handles. A `priceId` is what a dashboard
 * gives you; a `lookupKey` is what this library creates and what survives a
 * restore, because it names the tier rather than one price object. With a key,
 * the provider resolves it to whichever price currently answers for that tier,
 * so a catalog price change needs no config change.
 */
export interface StripeTier {
  readonly price: Price;
  readonly priceId?: string;
  readonly lookupKey?: string;
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
 * A Stripe processor. It moves money; paykit keeps the entitlement. The price
 * the catalog states is the price Stripe charges, checked by `Stack`.
 */
export const PaymentsStripe = (props: StripeProps): MoneyProvider<"processor"> => {
  const capabilities: ReadonlySet<PaymentCapability> = new Set<PaymentCapability>([
    "checkout",
    "portal",
    ...(props.bindings.createInvoice === undefined ? [] : (["invoice"] as const)),
    ...(props.bindings.createRefund === undefined ? [] : (["refund"] as const)),
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
        if (mapped.priceId !== undefined) {
          return props.bindings.createCheckoutSession({ account, tier, priceId: mapped.priceId });
        }
        // Configured by key: ask Stripe which price answers for the tier now, so
        // a replaced price needs no config change.
        if (mapped.lookupKey !== undefined && props.bindings.resolvePrice !== undefined) {
          return Effect.flatMap(props.bindings.resolvePrice(mapped.lookupKey), (priceId) =>
            props.bindings.createCheckoutSession({ account, tier, priceId }),
          );
        }
        return Effect.fail(
          new PaymentDeclined({
            provider: "stripe",
            code: "price_not_configured",
            message: `tier ${tier} has no priceId and no resolvable lookupKey`,
          }),
        );
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
