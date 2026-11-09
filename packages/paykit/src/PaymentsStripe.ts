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
import { asPricing, soleUnitPriceOf, type Pricing, type PricingValue } from "./Pricing.ts";
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
  }) => Effect.Effect<{ readonly url: string; readonly reference?: string }, PaymentError>;
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
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly refundId: string }, PaymentError>;
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
   * Optional: set a subscription item's quantity. A caller that cannot declares
   * no `quantity` capability, and a seat change stays a local proration.
   */
  readonly setQuantity?: (args: {
    readonly subscription: string;
    readonly priceId: string;
    readonly quantity: number;
    readonly proration: "immediate" | "none";
    readonly commandId: string;
  }) => Effect.Effect<{ readonly invoiceId?: string }, PaymentError>;
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
export type StripeUsagePrice =
  | UnitPrice
  | Pricing
  | {
      /** What one billable unit costs, for a one-rate price. */
      readonly unitPrice?: UnitPrice;
      /** The full pricing, for a package or a band ladder. */
      readonly pricing?: Pricing;
      readonly priceId?: string;
      readonly lookupKey?: string;
    };

/** Read a usage mapping in any of the forms the provider config accepts. */
const pricingOfUsage = (usage: StripeUsagePrice): Pricing => {
  if ("pricing" in usage && usage.pricing !== undefined) return usage.pricing;

  if ("unitPrice" in usage && usage.unitPrice !== undefined) {
    return { _tag: "unit", unitPrice: usage.unitPrice };
  }

  // SAFETY: after the `pricing` and `unitPrice` checks, the remaining usage is the one-rate input shape.
  return asPricing(usage as PricingValue);
};

/** The handle a checkout needs, when the usage mapping states one. */
const handleOf = (
  usage: StripeUsagePrice,
): { readonly priceId?: string; readonly lookupKey?: string } =>
  "priceId" in usage || "lookupKey" in usage
    ? {
        ...("priceId" in usage && usage.priceId !== undefined ? { priceId: usage.priceId } : {}),
        ...("lookupKey" in usage && usage.lookupKey !== undefined
          ? { lookupKey: usage.lookupKey }
          : {}),
      }
    : {};

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
  /**
   * One recurring seat price per non-consumable feature. The subscription item
   * quantity is what `SetQuantity` updates; the price is what the vendor
   * invoices.
   */
  readonly seats?: Readonly<Record<string, StripeUsagePrice>>;
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
    ...(props.bindings.setQuantity === undefined ? [] : (["quantity"] as const)),
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
          ...Object.values(mapped.usage ?? {}).map(handleOf),
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
      refund: ({
        chargeId,
        amount,
        commandId,
      }: {
        chargeId: string;
        amount: number;
        commandId?: string;
      }) =>
        props.bindings.createRefund === undefined
          ? missing("refund")
          : props.bindings.createRefund({
              chargeId,
              amount,
              ...(commandId === undefined ? {} : { commandId }),
            }),
      createPortal: ({ account }: { account: string }) =>
        props.bindings.createCustomerSession({ account }),
      setQuantity: ({
        account: _account,
        subscription,
        tier,
        feature,
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
      }) => {
        if (props.bindings.setQuantity === undefined) return missing("setQuantity");
        const seat = props.tiers?.[tier]?.seats?.[feature];

        if (seat === undefined) {
          return Effect.fail(
            new PaymentDeclined({
              provider: "stripe",
              code: "price_not_configured",
              message: `no Stripe seat price for ${tier}/${feature}`,
            }),
          );
        }

        const handle = handleOf(seat);

        const price =
          handle.priceId !== undefined
            ? Effect.succeed(handle.priceId)
            : handle.lookupKey !== undefined && props.bindings.resolvePrice !== undefined
              ? props.bindings.resolvePrice(handle.lookupKey)
              : Effect.fail(
                  new PaymentDeclined({
                    provider: "stripe",
                    code: "price_not_configured",
                    message: `seat ${tier}/${feature} has no priceId and no resolvable lookupKey`,
                  }),
                );

        return price.pipe(
          Effect.flatMap((priceId) =>
            props.bindings.setQuantity!({ subscription, priceId, quantity, proration, commandId }),
          ),
        );
      },
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

  const usagePrices: Record<string, Record<string, Pricing>> = {};
  const unitPrices: Record<string, Record<string, UnitPrice>> = {};

  for (const [tier, mapped] of Object.entries(props.tiers ?? {})) {
    if (mapped.usage === undefined) continue;

    for (const [feature, usage] of Object.entries(mapped.usage)) {
      const pricing = pricingOfUsage(usage);
      (usagePrices[tier] ??= {})[feature] = pricing;
      const sole = soleUnitPriceOf(pricing);

      if (sole !== null) (unitPrices[tier] ??= {})[feature] = sole;
    }
  }

  const seatPrices: Record<string, Record<string, UnitPrice>> = {};

  for (const [tier, mapped] of Object.entries(props.tiers ?? {})) {
    if (mapped.seats === undefined) continue;

    for (const [feature, seat] of Object.entries(mapped.seats)) {
      const unitPrice = soleUnitPriceOf(pricingOfUsage(seat));

      if (unitPrice !== null) (seatPrices[tier] ??= {})[feature] = unitPrice;
    }
  }

  return {
    name: "stripe",
    kind: "processor",
    capabilities,
    payments,
    ...(Object.keys(prices).length === 0 ? {} : { prices }),
    ...(Object.keys(unitPrices).length === 0 ? {} : { unitPrices }),
    ...(Object.keys(usagePrices).length === 0 ? {} : { usagePrices }),
    ...(Object.keys(seatPrices).length === 0 ? {} : { seatPrices }),
    ...(props.bindings.setQuantity === undefined ? {} : { seatScope: "feature" as const }),
    ...(props.webhook === undefined ? {} : { webhook: props.webhook }),
  };
};
