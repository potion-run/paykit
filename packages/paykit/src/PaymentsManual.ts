import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Payments,
  PaymentsProvider,
  ProviderCapabilityMissing,
  type PaymentCapability,
  type MoneyProvider,
} from "./Payments.ts";

const capabilities: ReadonlySet<PaymentCapability> = new Set(["invoice", "refund"]);

/**
 * The honest first provider: an invoice payable by transfer or cash. It has
 * no hosted checkout and no portal, so asking for one is a typed
 * `ProviderCapabilityMissing`, never a silent no-op.
 */
export const PaymentsManual = (): MoneyProvider<"manual"> => {
  let sequence = 0;
  const missing = (op: string) =>
    Effect.fail(new ProviderCapabilityMissing({ provider: "manual", op }));

  const service = Payments.toLayer(
    Effect.succeed({
      createCheckout: () => missing("createCheckout"),
      createInvoice: () => Effect.succeed({ invoiceId: `manual_invoice_${++sequence}` }),
      refund: () => Effect.succeed({}),
      createPortal: () => missing("createPortal"),
      // A manual invoice can bill a period, but it has no meter to feed: the
      // deploy can sell a postpaid tier, and the close refuses rather than
      // pretending the usage reached a vendor.
      reportUsage: () => missing("reportUsage"),
    }),
  );
  const payments = Layer.merge(
    service,
    Layer.succeed(PaymentsProvider, { name: "manual", capabilities }),
  );

  return { name: "manual", kind: "manual", capabilities, payments };
};
