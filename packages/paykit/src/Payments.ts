import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { UnitPrice } from "./Allowance.ts";
import type { Pricing } from "./Pricing.ts";
import { TierKind, type Price } from "./Tier.ts";
import type { PaymentsWebhook } from "./Webhooks.ts";

/**
 * One line of a usage report: the billable units a closed period recorded at
 * one price. A period can have several lines for one feature, because a
 * standing's unit price may change mid-period, and the vendor has to price each
 * unit at the price it was recorded at.
 */
export const UsageLine = Schema.Struct({
  feature: Schema.String,
  unitPrice: UnitPrice,
  quantity: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});

export type UsageLine = typeof UsageLine.Type;

/** A provider did not implement the operation a binding asked for. */
export class ProviderCapabilityMissing extends Schema.TaggedError<ProviderCapabilityMissing>()(
  "ProviderCapabilityMissing",
  {
    provider: Schema.String,
    op: Schema.String,
  },
) {}

/** The vendor refused a money operation. */
export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()("PaymentDeclined", {
  provider: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

/** The only errors a `Payments` operation may return. */
export type PaymentError = ProviderCapabilityMissing | PaymentDeclined;

/** The optional surface a provider may add to the required port. */
export const PaymentCapability = Schema.Literals([
  "checkout",
  "invoice",
  /**
   * Take an amount from the customer's saved method, without a checkout and
   * without the vendor's collection schedule. An auto top-up prefers it and
   * falls back to `invoice`; a dunning retry requires it.
   */
  "charge",
  "refund",
  "portal",
  "usage",
  /**
   * Open a hosted page where the customer adds a payment method without a
   * purchase. A provider that cannot declares no `setup`, and asking for one is
   * `ProviderCapabilityMissing` rather than a URL that cannot take a card.
   */
  "setup",
  /**
   * Set a subscription item's quantity, which is how a seat change reaches the
   * vendor's next invoice. A provider that cannot declares no `quantity`, and
   * the seat change stays a local proration for `ChargeQuantityProration`.
   */
  "quantity",
]);

export type PaymentCapability = typeof PaymentCapability.Type;

export const PaymentCapabilities = Schema.Array(PaymentCapability);

/**
 * The money plane as a port. The required surface is what every provider can
 * do: sell through a purchase path and refund. The rest is declared by the
 * provider and surfaced as capabilities.
 */
export const Payments = Domain.ExternalSystem("Payments", {
  createCheckout: {
    args: { account: Schema.String, tier: Schema.String, kind: TierKind },
    success: {
      url: Schema.String,
      /**
       * The vendor's own id for the checkout session, when it can name one. It
       * is what a webhook completion quotes back to find the terms that were
       * sold (ADR 0044 §1); a provider that cannot name one omits it.
       */
      reference: Schema.optionalKey(Schema.String),
    },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  createInvoice: {
    args: {
      account: Schema.String,
      amount: Schema.Int,
      currency: Schema.String,
      /**
       * Idempotency key for the charge. A provider that supports one returns the
       * invoice it already opened when the same key is sent again, so a retry
       * after a crash is not a second invoice. Optional because a manual invoice
       * or a vendor with no idempotency contract cannot honor one.
       */
      commandId: Schema.optionalKey(Schema.String),
    },
    success: { invoiceId: Schema.String },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  charge: {
    args: {
      account: Schema.String,
      amount: Schema.Int,
      currency: Schema.String,
      /** The same idempotency key the invoice would have used: the crossing. */
      commandId: Schema.optionalKey(Schema.String),
    },
    success: { chargeId: Schema.String },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  refund: {
    args: {
      chargeId: Schema.String,
      amount: Schema.Int,
      /**
       * Idempotency key for the refund: the operator's dedupe key, so a retry
       * is the refund the provider already took rather than a second one.
       */
      commandId: Schema.optionalKey(Schema.String),
    },
    success: { refundId: Schema.String },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  createPortal: {
    args: { account: Schema.String },
    success: { url: Schema.String },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  setupPayment: {
    args: {
      account: Schema.String,
      /** Idempotency key for the session, when the provider supports one. */
      commandId: Schema.optionalKey(Schema.String),
    },
    success: { url: Schema.String },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  setQuantity: {
    args: {
      account: Schema.String,
      /** The vendor subscription the quantity belongs to. */
      subscription: Schema.String,
      /** The tier the seat price belongs to. */
      tier: Schema.String,
      /** The non-consumable feature whose quantity changed. */
      feature: Schema.String,
      /** The total quantity to hold, including the free grant. */
      quantity: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      /**
       * What the vendor does with the difference: `immediate` invoices the
       * proration now, `none` lets the next period bill the new quantity.
       */
      proration: Schema.Literals(["immediate", "none"]),
      /** Idempotency key: the quantity change, so a retry is one update. */
      commandId: Schema.String,
    },
    success: {
      /** The invoice the vendor opened for an immediate proration, when it did. */
      invoiceId: Schema.optionalKey(Schema.String),
    },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  reportUsage: {
    args: {
      account: Schema.String,
      /** The closed period the quantities belong to. */
      periodStart: Schema.DateTimeUtc,
      periodEnd: Schema.DateTimeUtc,
      /** The billable units, one line per price they were recorded at. */
      lines: Schema.Array(UsageLine),
      /** Idempotency key: the closing period, so a redelivery is the same report. */
      commandId: Schema.String,
    },
    success: {},
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
});

/** What `yield* Payments` gives a binding. */
export interface PaymentsService {
  readonly createCheckout: (args: {
    readonly account: string;
    readonly tier: string;
    /** A subscription opens a period; a one-off pack is a single payment. */
    readonly kind: TierKind;
  }) => Effect.Effect<{ readonly url: string; readonly reference?: string }, PaymentError>;
  readonly createInvoice: (args: {
    readonly account: string;
    readonly amount: number;
    readonly currency: string;
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly invoiceId: string }, PaymentError>;
  readonly charge: (args: {
    readonly account: string;
    readonly amount: number;
    readonly currency: string;
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly chargeId: string }, PaymentError>;
  readonly refund: (args: {
    readonly chargeId: string;
    readonly amount: number;
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly refundId: string }, PaymentError>;
  readonly createPortal: (args: {
    readonly account: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  readonly setupPayment: (args: {
    readonly account: string;
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId?: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  readonly reportUsage: (args: {
    readonly account: string;
    readonly periodStart: DateTime.Utc;
    readonly periodEnd: DateTime.Utc;
    /** The billable units, one line per price they were recorded at. */
    readonly lines: ReadonlyArray<UsageLine>;
    readonly commandId: string;
  }) => Effect.Effect<{}, PaymentError>;
  readonly setQuantity: (args: {
    readonly account: string;
    /** The vendor subscription the quantity belongs to. */
    readonly subscription: string;
    readonly tier: string;
    readonly feature: string;
    /** The total quantity to hold, including the free grant. */
    readonly quantity: number;
    /** `immediate` invoices the difference; `none` bills it next period. */
    readonly proration: "immediate" | "none";
    /** Stable across retries; a provider that can dedupe must use it. */
    readonly commandId: string;
  }) => Effect.Effect<{ readonly invoiceId?: string }, PaymentError>;
}

/** The provider behind the `Payments` service: its name and declared ops. */
export class PaymentsProvider extends Context.Service<
  PaymentsProvider,
  {
    readonly name: string;
    readonly capabilities: ReadonlySet<PaymentCapability>;
  }
>()("paykit/PaymentsProvider") {}

/** A provider is a processor or a merchant of record, or an honest fake. */
export const MoneyProviderKind = Schema.Literals([
  "processor",
  "merchant_of_record",
  "manual",
  "memory",
]);

export type MoneyProviderKind = typeof MoneyProviderKind.Type;

/**
 * The layer a provider's `payments` field carries: the `Payments` port, built
 * from the provider's own props. Spelling out the parameters matters — a bare
 * `ReturnType<typeof Payments.toLayer>` leaves them `unknown`, which then leaks
 * `unknown` into every requirement of the stack that merges the provider.
 */
export type PaymentsLayer = ReturnType<typeof Payments.toLayer<never, never>>;

/**
 * What `Paykit.<Provider>()` returns: a name, a kind, its ops, its webhook and
 * the adapter.
 *
 * Not `Provider` — Alchemy owns that word for the service that reconciles a
 * resource (`alchemy/Provider`), and the two live in the same file here
 * (`BillingStack.resource.ts`). This is the money plane's provider: a value the
 * catalog is checked against and the router dispatches to, never a lifecycle.
 */
export interface MoneyProvider<Kind extends MoneyProviderKind = MoneyProviderKind> {
  /**
   * What this provider is called in `refs`, and how a router finds it. Stable:
   * an account's vendor references are keyed by it, so renaming one orphans
   * every standing it described.
   */
  readonly name: string;
  readonly kind: Kind;
  readonly capabilities: ReadonlySet<PaymentCapability>;
  readonly payments: PaymentsLayer;
  /** The provider's price handle per tier. The catalog stays provider-free. */
  readonly prices?: Readonly<Record<string, Price>>;
  /**
   * What the provider charges per billable unit, per tier and feature. Kept for
   * a one-rate price; a
   * provider that can hold a ladder states the whole pricing there instead.
   */
  readonly unitPrices?: UnitPriceMap;
  /**
   * The full pricing a provider holds per billable feature: one rate, a package
   * or a band ladder. The deploy compares it with the catalog's `pricingOf`; a
   * disagreement is a refusal, never a runtime conversion.
   */
  readonly usagePrices?: UsagePricingMap;
  /**
   * What the provider charges per seat, per tier and feature. A provider that
   * declares `quantity` must map every billable seat; a disagreement is a
   * deploy refusal, like a unit price.
   */
  readonly seatPrices?: UnitPriceMap;
  /**
   * Whether the vendor's seat count is per feature or per subscription. A
   * subscription-wide count can only own one seat feature per tier; Stripe's
   * subscription items are per feature, Polar's `seats` is one number.
   */
  readonly seatScope?: "feature" | "subscription";
  /**
   * How this provider reports a payment, when it can. A provider that sells a
   * priced tier but cannot say it was paid leaves the account waiting for a
   * webhook that never comes; carrying the decoder here keeps the secret and
   * the tier mapping to one config.
   */
  readonly webhook?: PaymentsWebhook;
}

/** A provider's unit prices, keyed by tier and then by feature. */
export type UnitPriceMap = Readonly<Record<string, Readonly<Record<string, UnitPrice>>>>;

/** A provider's full usage pricings, keyed by tier and then by feature. */
export type UsagePricingMap = Readonly<Record<string, Readonly<Record<string, Pricing>>>>;

/** The providers a deployment runs, and the one that serves a new account. */
export interface ProviderSet {
  readonly all: ReadonlyArray<MoneyProvider>;
  readonly byName: ReadonlyMap<string, MoneyProvider>;
  /** The provider a purchase starts on while the account holds no refs. */
  readonly fallback: MoneyProvider | null;
}

/**
 * Every provider a deployment runs, in preference order. Provide this instead
 * of merging provider layers — merging two would leave one `Payments` in
 * context and the other shadowed by merge order.
 */
export class PaymentsRouter extends Context.Service<PaymentsRouter, ProviderSet>()(
  "paykit/PaymentsRouter",
) {}

/** One layer holding every provider a deployment runs, first one preferred. */
export const paymentsRouter = (
  ...providers: ReadonlyArray<MoneyProvider>
): Layer.Layer<PaymentsRouter> =>
  Layer.succeed(PaymentsRouter, {
    all: providers,
    byName: new Map(providers.map((provider) => [provider.name, provider])),
    fallback: providers[0] ?? null,
  });

/**
 * The provider that serves an account: the one its `refs` name, else the
 * fallback. Pure, so a binding resolves and then provides exactly one layer.
 */
export const providerFor = (
  set: ProviderSet,
  refs: Readonly<Record<string, unknown>>,
): MoneyProvider | null => {
  for (const name of Object.keys(refs)) {
    const found = set.byName.get(name);

    if (found !== undefined) return found;
  }

  return set.fallback;
};
