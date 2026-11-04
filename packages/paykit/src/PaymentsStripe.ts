import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PaymentDeclined,
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
  type PaymentCapability,
  type PaymentError,
  type Provider,
} from "./Payments.ts";
import type { Price } from "./Tier.ts";

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
  readonly createRefund: (args: {
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
  readonly bindings: StripeBindings;
  readonly tiers?: Readonly<Record<string, StripeTier>>;
}

/**
 * A Stripe processor. It moves money; paykit keeps the entitlement. The price
 * the catalog states is the price Stripe charges, checked by `Stack`.
 */
export const PaymentsStripe = (props: StripeProps): Provider<"processor"> => {
  const capabilities: ReadonlySet<PaymentCapability> = new Set(
    props.bindings.syncTier === undefined
      ? ["checkout", "refund", "portal"]
      : ["checkout", "refund", "portal", "syncTier"],
  );
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
      createInvoice: () => missing("createInvoice"),
      refund: ({ chargeId, amount }: { chargeId: string; amount: number }) =>
        props.bindings.createRefund({ chargeId, amount }),
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
    kind: "processor",
    capabilities,
    payments,
    ...(Object.keys(prices).length === 0 ? {} : { prices }),
  };
};
