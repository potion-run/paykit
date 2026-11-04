import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Price } from "./Tier.ts";

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
  "syncTier",
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
    args: { account: Schema.String, tier: Schema.String },
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
  syncTier: {
    args: { account: Schema.String, tier: Schema.String },
    success: {},
    error: [ProviderCapabilityMissing, PaymentDeclined],
  },
});

/** What `yield* Payments` gives a binding. */
export interface PaymentsService {
  readonly createCheckout: (args: {
    readonly account: string;
    readonly tier: string;
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
  readonly syncTier: (args: {
    readonly account: string;
    readonly tier: string;
  }) => Effect.Effect<void, PaymentError>;
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
export const ProviderKind = Schema.Literals([
  "processor",
  "merchant_of_record",
  "manual",
  "memory",
]);
export type ProviderKind = typeof ProviderKind.Type;

/** What `Paykit.<Provider>()` returns: a kind, its ops, and the `Payments` adapter. */
export interface Provider<Kind extends ProviderKind = ProviderKind> {
  readonly kind: Kind;
  readonly capabilities: ReadonlySet<PaymentCapability>;
  readonly payments: ReturnType<typeof Payments.toLayer>;
  /** The provider's price handle per tier. The catalog stays provider-free. */
  readonly prices?: Readonly<Record<string, Price>>;
}
