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

/** The `@potion.run/paykit-polar` bindings paykit consumes. */
export interface PolarBindings {
  readonly createCheckoutSession: (args: {
    readonly account: string;
    readonly tier: string;
    readonly productId: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  readonly createCustomerSession: (args: {
    readonly account: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  readonly createRefund: (args: {
    readonly chargeId: string;
    readonly amount: number;
  }) => Effect.Effect<{}, PaymentError>;
  /** Optional: write the tier into Polar benefits. Never read back. */
  readonly syncTier?: (args: {
    readonly account: string;
    readonly tier: string;
  }) => Effect.Effect<{}, PaymentError>;
}

/** Where a tier lives in Polar, and the same price the catalog states. */
export interface PolarTier {
  readonly price: Price;
  readonly productId: string;
}

export interface PolarProps {
  readonly bindings: PolarBindings;
  readonly tiers?: Readonly<Record<string, PolarTier>>;
}

/**
 * A Polar merchant of record. It owns tax, receipts and the portal; paykit
 * still owns the entitlement. Polar embeds prices in products, so the handle
 * is a product, never a separate price.
 */
export const PaymentsPolar = (props: PolarProps): Provider<"merchant_of_record"> => {
  const capabilities: ReadonlySet<PaymentCapability> = new Set(
    props.bindings.syncTier === undefined
      ? ["checkout", "refund", "portal"]
      : ["checkout", "refund", "portal", "syncTier"],
  );
  const missing = (op: string) =>
    Effect.fail(new ProviderCapabilityMissing({ provider: "polar", op }));

  const service = Payments.toLayer(
    Effect.succeed({
      createCheckout: ({ account, tier }: { account: string; tier: string }) => {
        const mapped = props.tiers?.[tier];
        if (mapped === undefined) {
          return Effect.fail(
            new PaymentDeclined({
              provider: "polar",
              code: "product_not_configured",
              message: `no Polar product for ${tier}`,
            }),
          );
        }
        return props.bindings.createCheckoutSession({
          account,
          tier,
          productId: mapped.productId,
        });
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
    Layer.succeed(PaymentsProvider, { name: "polar", capabilities }),
  );

  const prices = Object.fromEntries(
    Object.entries(props.tiers ?? {}).map(([tier, mapped]) => [tier, mapped.price]),
  );

  return {
    kind: "merchant_of_record",
    capabilities,
    payments,
    ...(Object.keys(prices).length === 0 ? {} : { prices }),
  };
};
