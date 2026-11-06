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

/** The Stripe calls this adapter consumes, supplied by a vendor package. */
export interface StripeBindings {
  readonly createCheckoutSession: (args: {
    readonly account: string;
    readonly tier: string;
    /** The base price first, then one metered price per billable feature. */
    readonly priceIds: ReadonlyArray<string>;
    /** A subscription opens a period; a one-off pack is a single payment. */
    readonly kind: TierKind;
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
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly invoiceId: string }, PaymentError>;
  /** Optional: a caller that cannot refund declares no `refund` capability. */
  readonly createRefund?: (args: {
    readonly chargeId: string;
    readonly amount: number;
  }) => Effect.Effect<{}, PaymentError>;
  /**
   * Optional: take an amount from the customer's saved method, off-session.
   * A caller that cannot declares no `charge` capability, and the auto top-up
   * falls back to `createInvoice`.
   */
  readonly charge?: (args: {
    readonly account: string;
    readonly amount: number;
    readonly currency: string;
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly chargeId: string }, PaymentError>;
  /**
   * Optional: report a closed period's billable units to the vendor's meters.
   * A caller that cannot report declares no `usage` capability, and a close
   * that needs one fails with `ProviderCapabilityMissing`.
   */
  readonly reportUsage?: (args: {
    readonly account: string;
    readonly periodStart: DateTime.Utc;
    readonly periodEnd: DateTime.Utc;
    readonly lines: ReadonlyArray<UsageLine>;
    readonly commandId: string;
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
export interface StripeUsagePrice {
  /** What one billable unit costs, and what the deploy checks the catalog against. */
  readonly unitPrice: UnitPrice;
  readonly priceId?: string;
  readonly lookupKey?: string;
}

export interface StripeTier {
  readonly price: Price;
  readonly priceId?: string;
  readonly lookupKey?: string;
  /**
   * One metered price per billable feature. The price is created by
   * `StripePrices`; a tier with a postpaid allowance must map every feature so
   * the checkout attaches the meter rather than billing only locally.
   */
  readonly usage?: Readonly<Record<string, StripeUsagePrice>>;
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
    ...(props.bindings.charge === undefined ? [] : (["charge"] as const)),
    ...(props.bindings.createRefund === undefined ? [] : (["refund"] as const)),
    ...(props.bindings.reportUsage === undefined ? [] : (["usage"] as const)),
  ]);
  const missing = (op: string) =>
    Effect.fail(new ProviderCapabilityMissing({ provider: "stripe", op }));

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
              provider: "stripe",
              code: "price_not_configured",
              message: `no Stripe price for ${tier}`,
            }),
          );
        }
        // The base price and every metered price are line items on the same
        // subscription. Without the metered prices, a meter event has no price
        // to charge and the vendor invoice would omit the usage.
        const handles: ReadonlyArray<{ readonly priceId?: string; readonly lookupKey?: string }> = [
          mapped,
          ...Object.values(mapped.usage ?? {}),
        ];
        return Effect.forEach(
          handles,
          (handle): Effect.Effect<string, PaymentError> => {
            if (handle.priceId !== undefined) return Effect.succeed(handle.priceId);
            // Configured by key: ask Stripe which price answers for the tier
            // now, so a replaced price needs no config change.
            if (handle.lookupKey !== undefined && props.bindings.resolvePrice !== undefined) {
              return props.bindings.resolvePrice(handle.lookupKey);
            }
            return Effect.fail(
              new PaymentDeclined({
                provider: "stripe",
                code: "price_not_configured",
                message: `tier ${tier} has a price with no priceId and no resolvable lookupKey`,
              }),
            );
          },
          { concurrency: 1 },
        ).pipe(
          Effect.flatMap((priceIds) =>
            props.bindings.createCheckoutSession({ account, tier, priceIds, kind }),
          ),
        );
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
      charge: ({
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
        props.bindings.charge === undefined
          ? missing("charge")
          : props.bindings.charge({
              account,
              amount,
              currency,
              ...(commandId === undefined ? {} : { commandId }),
            }),
      refund: ({ chargeId, amount }: { chargeId: string; amount: number }) =>
        props.bindings.createRefund === undefined
          ? missing("refund")
          : props.bindings.createRefund({ chargeId, amount }),
      createPortal: ({ account }: { account: string }) =>
        props.bindings.createCustomerSession({ account }),
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
    Layer.succeed(PaymentsProvider, { name: "stripe", capabilities }),
  );

  const prices = Object.fromEntries(
    Object.entries(props.tiers ?? {}).map(([tier, mapped]) => [tier, mapped.price]),
  );
  const unitPrices = Object.fromEntries(
    Object.entries(props.tiers ?? {}).flatMap(([tier, mapped]) =>
      mapped.usage === undefined
        ? []
        : [
            [
              tier,
              Object.fromEntries(
                Object.entries(mapped.usage).map(([feature, usage]) => [feature, usage.unitPrice]),
              ),
            ] as const,
          ],
    ),
  );

  return {
    name: "stripe",
    kind: "processor",
    capabilities,
    payments,
    ...(Object.keys(prices).length === 0 ? {} : { prices }),
    ...(Object.keys(unitPrices).length === 0 ? {} : { unitPrices }),
    ...(props.webhook === undefined ? {} : { webhook: props.webhook }),
  };
};
