import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { UnitPrice } from "./Allowance.ts";
import { TierKind, type Price } from "./Tier.ts";
import type { PaymentsWebhook } from "./Webhooks.ts";

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
  "refund",
  "portal",
  "usage",
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
    success: { url: Schema.String },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  createInvoice: {
    args: { account: Schema.String, amount: Schema.Int, currency: Schema.String },
    success: { invoiceId: Schema.String },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  refund: {
    args: { chargeId: Schema.String, amount: Schema.Int },
    success: {},
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  createPortal: {
    args: { account: Schema.String },
    success: { url: Schema.String },
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
  reportUsage: {
    args: {
      account: Schema.String,
      /** The closed period the quantities belong to. */
      periodStart: Schema.DateTimeUtc,
      periodEnd: Schema.DateTimeUtc,
      /** The billable units of each metered feature: the part past `included`. */
      quantities: Schema.Record(
        Schema.String,
        Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      ),
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
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  readonly createInvoice: (args: {
    readonly account: string;
    readonly amount: number;
    readonly currency: string;
  }) => Effect.Effect<{ readonly invoiceId: string }, PaymentError>;
  readonly refund: (args: {
    readonly chargeId: string;
    readonly amount: number;
  }) => Effect.Effect<void, PaymentError>;
  readonly createPortal: (args: {
    readonly account: string;
  }) => Effect.Effect<{ readonly url: string }, PaymentError>;
  readonly reportUsage: (args: {
    readonly account: string;
    readonly periodStart: DateTime.Utc;
    readonly periodEnd: DateTime.Utc;
    /** Billable units per feature. A zero quantity is not a usage report. */
    readonly quantities: Readonly<Record<string, number>>;
    readonly commandId: string;
  }) => Effect.Effect<{}, PaymentError>;
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
   * What the provider charges per billable unit, per tier and feature. The
   * deploy compares it with the catalog's `Allowance.unitPrice`; a disagreement
   * is a refusal, never a runtime conversion.
   */
  readonly unitPrices?: UnitPriceMap;
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
