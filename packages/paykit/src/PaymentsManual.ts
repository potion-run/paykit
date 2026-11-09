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
  const invoiceFor = new Map<string, string>();
  const refundFor = new Map<string, string>();

  const missing = (op: string) =>
    Effect.fail(new ProviderCapabilityMissing({ provider: "manual", op }));

  const service = Payments.toLayer(
    Effect.succeed({
      createCheckout: () => missing("createCheckout"),
      createInvoice: ({ commandId }: { commandId?: string }) =>
        Effect.sync(() => {
          // A manual invoice is inferred from a transfer: the same command id
          // must resolve to the invoice it already produced.
          const previous = commandId === undefined ? undefined : invoiceFor.get(commandId);

          if (previous !== undefined) return { invoiceId: previous };
          const invoiceId = `manual_invoice_${++sequence}`;

          if (commandId !== undefined) invoiceFor.set(commandId, invoiceId);

          return { invoiceId };
        }),
      refund: ({ commandId }: { commandId?: string }) =>
        Effect.sync(() => {
          // A manual refund is a transfer back: the same dedupe key must answer
          // the refund it already recorded.
          const previous = commandId === undefined ? undefined : refundFor.get(commandId);

          if (previous !== undefined) return { refundId: previous };
          const refundId = `manual_refund_${++sequence}`;

          if (commandId !== undefined) refundFor.set(commandId, refundId);

          return { refundId };
        }),
      createPortal: () => missing("createPortal"),
      // A manual provider has no card rail to add a method to: a setup page is
      // refused by capability, not faked as an invoice.
      setupPayment: () => missing("setupPayment"),
      // A manual invoice has a transfer behind it and no card to charge: a
      // charge is refused by capability, not faked as an invoice.
      charge: () => missing("charge"),
      // A manual invoice can bill a period, but it has no meter to feed: the
      // deploy can sell a postpaid tier, and the close refuses rather than
      // pretending the usage reached a vendor.
      reportUsage: () => missing("reportUsage"),
      // A manual provider has no subscription item to set; a seat change stays
      // a local proration for `ChargeQuantityProration`.
      setQuantity: () => missing("setQuantity"),
    }),
  );

  const payments = Layer.merge(
    service,
    Layer.succeed(PaymentsProvider, { name: "manual", capabilities }),
  );

  return { name: "manual", kind: "manual", capabilities, payments };
};
