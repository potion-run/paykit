import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PaymentDeclined,
  Payments,
  PaymentsProvider,
  type PaymentCapability,
  type MoneyProvider,
} from "./Payments.ts";

const capabilities: ReadonlySet<PaymentCapability> = new Set([
  "checkout",
  "invoice",
  "refund",
  "portal",
]);

/**
 * The in-memory provider: a full capability surface that never moves money.
 * Use it for tests and `alchemy dev`, never in production.
 */
export const PaymentsMemory = (): MoneyProvider<"memory"> => {
  const checkouts = new Map<string, { account: string; tier: string }>();
  const invoices = new Map<string, { account: string; amount: number; currency: string }>();
  let sequence = 0;

  const service = Payments.toLayer(
    Effect.sync(() => {
      const next = () => `${++sequence}`;
      return {
        createCheckout: ({ account, tier }: { account: string; tier: string }) =>
          Effect.sync(() => {
            const id = `co_${next()}`;
            checkouts.set(id, { account, tier });
            return { url: `https://paykit.memory/checkout/${id}` };
          }),
        createInvoice: ({
          account,
          amount,
          currency,
        }: {
          account: string;
          amount: number;
          currency: string;
        }) => {
          if (amount <= 0) {
            return Effect.fail(
              new PaymentDeclined({
                provider: "memory",
                code: "invalid_amount",
                message: "an invoice needs a positive amount",
              }),
            );
          }
          return Effect.sync(() => {
            const id = `in_${next()}`;
            invoices.set(id, { account, amount, currency });
            return { invoiceId: id };
          });
        },
        refund: ({ chargeId, amount }: { chargeId: string; amount: number }) =>
          Effect.sync(() => {
            void chargeId;
            void amount;
            return {};
          }),
        createPortal: ({ account }: { account: string }) =>
          Effect.succeed({
            url: `https://paykit.memory/portal/${encodeURIComponent(account)}`,
          }),
      };
    }),
  );
  const payments = Layer.merge(
    service,
    Layer.succeed(PaymentsProvider, { name: "memory", capabilities }),
  );

  return { name: "memory", kind: "memory", capabilities, payments };
};
