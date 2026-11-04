import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
  type PaymentCapability,
  type Provider,
} from "./Payments.ts";

const capabilities: ReadonlySet<PaymentCapability> = new Set(["invoice", "refund"]);

/**
 * The honest first provider: an invoice payable by transfer or cash. It has
 * no hosted checkout, no portal and no tier sync, so asking for one is a
 * typed `ProviderCapabilityMissing`, never a silent no-op.
 */
export const PaymentsManual = (): Provider<"manual"> => {
  let sequence = 0;
  const missing = (op: string) =>
    Effect.fail(new ProviderCapabilityMissing({ provider: "manual", op }));

  const service = Payments.toLayer(
    Effect.succeed({
      createCheckout: () => missing("createCheckout"),
      createInvoice: () => Effect.succeed({ invoiceId: `manual_invoice_${++sequence}` }),
      refund: () => Effect.succeed({}),
      createPortal: () => missing("createPortal"),
      syncTier: () => missing("syncTier"),
    }),
  );
  const payments = Layer.merge(
    service,
    Layer.succeed(PaymentsProvider, { name: "manual", capabilities }),
  );

  return { kind: "manual", capabilities, payments };
};
