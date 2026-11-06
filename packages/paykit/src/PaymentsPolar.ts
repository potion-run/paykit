import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { UnitPrice } from "./Allowance.ts";
import {
  PaymentDeclined,
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
  type PaymentCapability,
  type PaymentError,
  type MoneyProvider,
  type UsageLine,
} from "./Payments.ts";
import type { Price, TierKind } from "./Tier.ts";
import type { PaymentsWebhook } from "./Webhooks.ts";

/** The `@potion.run/paykit-polar` bindings paykit consumes. */
export interface PolarBindings {
  readonly createCheckoutSession: (args: {
    readonly account: string;
    readonly tier: string;
    readonly productId: string;
    /** A subscription opens a period; a one-off pack is a single payment. */
    readonly kind: TierKind;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  readonly createCustomerSession: (args: {
    readonly account: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  /**
   * Optional: bill an amount on its own, which is how a mid-cycle proration is
   * collected. A merchant of record that can sell a tier can usually also open
   * a one-off charge, but not always, so the adapter declares it only when it
   * is supplied.
   */
  readonly createInvoice?: (args: {
    readonly account: string;
    readonly amount: number;
    readonly currency: string;
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly invoiceId: string }, PaymentError>;
  readonly createRefund: (args: {
    readonly chargeId: string;
    readonly amount: number;
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly refundId: string }, PaymentError>;
  /**
   * Optional: set the subscription's seat count. Polar's count is one number on
   * the subscription, so the provider declares `seatScope: "subscription"`.
   */
  readonly setQuantity?: (args: {
    readonly subscription: string;
    readonly seats: number;
    readonly proration: "immediate" | "none";
    readonly commandId: string;
  }) => Effect.Effect<{ readonly invoiceId?: string }, PaymentError>;
  /**
   * Optional: report a closed period's billable units to the vendor's meters.
   * A merchant of record that can ingest usage declares it; one that cannot
   * leaves the close with `ProviderCapabilityMissing`.
   */
  readonly reportUsage?: (args: {
    readonly account: string;
    readonly periodStart: DateTime.Utc;
    readonly periodEnd: DateTime.Utc;
    readonly lines: ReadonlyArray<UsageLine>;
    readonly commandId: string;
  }) => Effect.Effect<{}, PaymentError>;
}

/** Where a tier lives in Polar, and the same price the catalog states. */
export interface PolarTier {
  readonly price: Price;
  readonly productId: string;
  /**
   * One metered price per billable feature, embedded in the product. The deploy
   * checks each unit price against the catalog before anything is billed.
   */
  readonly usage?: Readonly<Record<string, UnitPrice>>;
  /**
   * The per-seat price of the product's seat-based price. Polar's seat count is
   * subscription-wide, so a tier may map only one billable seat feature.
   */
  readonly seats?: Readonly<Record<string, UnitPrice>>;
}

export interface PolarProps {
  /**
   * How this provider reports a payment, when the deployment has a signing
   * secret for it. `Stack` records whether one is present.
   */
  readonly webhook?: PaymentsWebhook;
  readonly bindings: PolarBindings;
  readonly tiers?: Readonly<Record<string, PolarTier>>;
}

/**
 * A Polar merchant of record. It owns tax, receipts and the portal; paykit
 * still owns the entitlement. Polar embeds prices in products, so the handle
 * is a product, never a separate price.
 */
export const PaymentsPolar = (props: PolarProps): MoneyProvider<"merchant_of_record"> => {
  const capabilities: ReadonlySet<PaymentCapability> = new Set([
    "checkout",
    "refund",
    "portal",
    ...(props.bindings.createInvoice === undefined ? [] : (["invoice"] as const)),
    ...(props.bindings.reportUsage === undefined ? [] : (["usage"] as const)),
    ...(props.bindings.setQuantity === undefined ? [] : (["quantity"] as const)),
  ]);
  const missing = (op: string) =>
    Effect.fail(new ProviderCapabilityMissing({ provider: "polar", op }));

  const service = Payments.toLayer(
    Effect.succeed({
      createCheckout: ({
        account,
        tier,
        kind,
      }: {
        account: string;
        tier: string;
        kind: TierKind;
      }) => {
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
          kind,
        });
      },
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
        props.bindings.createInvoice === undefined
          ? missing("createInvoice")
          : props.bindings.createInvoice({
              account,
              amount,
              currency,
              ...(commandId === undefined ? {} : { commandId }),
            }),
      refund: ({
        chargeId,
        amount,
        commandId,
      }: {
        chargeId: string;
        amount: number;
        commandId?: string;
      }) =>
        props.bindings.createRefund({
          chargeId,
          amount,
          ...(commandId === undefined ? {} : { commandId }),
        }),
      // Polar is a merchant of record: `createInvoice` finalizes an order, which
      // is itself an off-session attempt on the saved method. A second charge
      // op would be a second way to take one payment, so the port refuses it.
      charge: () => missing("charge"),
      createPortal: ({ account }: { account: string }) =>
        props.bindings.createCustomerSession({ account }),
      setQuantity: ({
        subscription,
        quantity,
        proration,
        commandId,
      }: {
        account: string;
        subscription: string;
        tier: string;
        feature: string;
        quantity: number;
        proration: "immediate" | "none";
        commandId: string;
      }) =>
        props.bindings.setQuantity === undefined
          ? missing("setQuantity")
          : props.bindings.setQuantity({
              subscription,
              seats: quantity,
              proration,
              commandId,
            }),
      reportUsage: (args: {
        account: string;
        periodStart: DateTime.Utc;
        periodEnd: DateTime.Utc;
        lines: ReadonlyArray<UsageLine>;
        commandId: string;
      }) =>
        props.bindings.reportUsage === undefined
          ? missing("reportUsage")
          : props.bindings.reportUsage(args),
    }),
  );
  const payments = Layer.merge(
    service,
    Layer.succeed(PaymentsProvider, { name: "polar", capabilities }),
  );

  const prices = Object.fromEntries(
    Object.entries(props.tiers ?? {}).map(([tier, mapped]) => [tier, mapped.price]),
  );
  const unitPrices = Object.fromEntries(
    Object.entries(props.tiers ?? {}).flatMap(([tier, mapped]) =>
      mapped.usage === undefined ? [] : [[tier, { ...mapped.usage }] as const],
    ),
  );
  const seatPrices = Object.fromEntries(
    Object.entries(props.tiers ?? {}).flatMap(([tier, mapped]) =>
      mapped.seats === undefined ? [] : [[tier, { ...mapped.seats }] as const],
    ),
  );

  return {
    name: "polar",
    kind: "merchant_of_record",
    capabilities,
    payments,
    ...(Object.keys(prices).length === 0 ? {} : { prices }),
    ...(Object.keys(unitPrices).length === 0 ? {} : { unitPrices }),
    ...(Object.keys(seatPrices).length === 0 ? {} : { seatPrices }),
    ...(props.bindings.setQuantity === undefined ? {} : { seatScope: "subscription" as const }),
    ...(props.webhook === undefined ? {} : { webhook: props.webhook }),
  };
};
