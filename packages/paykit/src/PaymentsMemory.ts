import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PaymentDeclined,
  Payments,
  PaymentsProvider,
  type PaymentCapability,
  type MoneyProvider,
  type UsageLine,
} from "./Payments.ts";

const capabilities: ReadonlySet<PaymentCapability> = new Set([
  "checkout",
  "invoice",
  "refund",
  "portal",
  "usage",
]);

/** One report the memory provider accepted, deduped by its command id. */
export interface MemoryUsageReport {
  readonly account: string;
  readonly periodStart: DateTime.Utc;
  readonly periodEnd: DateTime.Utc;
  readonly lines: ReadonlyArray<UsageLine>;
  readonly commandId: string;
}

/** The memory provider, plus the reports it accepted for a test to read. */
export interface MemoryPayments extends MoneyProvider<"memory"> {
  readonly reports: ReadonlyArray<MemoryUsageReport>;
}

/**
 * The in-memory provider: a full capability surface that never moves money.
 * Use it for tests and `alchemy dev`, never in production.
 */
export const PaymentsMemory = (): MemoryPayments => {
  const checkouts = new Map<string, { account: string; tier: string }>();
  const invoices = new Map<string, { account: string; amount: number; currency: string }>();
  /** The invoice a command id already opened, so a retry is the same charge. */
  const invoiceFor = new Map<string, string>();
  const reports: Array<MemoryUsageReport> = [];
  const reported = new Set<string>();
  let sequence = 0;

  const service = Payments.toLayer(
    Effect.sync(() => {
      const next = () => `${++sequence}`;
      return {
        createCheckout: ({
          account,
          tier,
        }: {
          account: string;
          tier: string;
          kind: "subscription" | "one_off";
        }) =>
          Effect.sync(() => {
            const id = `co_${next()}`;
            checkouts.set(id, { account, tier });
            return { url: `https://paykit.memory/checkout/${id}` };
          }),
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
            // The command id is the vendor's idempotency key: a retried charge
            // is the invoice it already opened, not a second one.
            const previous = commandId === undefined ? undefined : invoiceFor.get(commandId);
            if (previous !== undefined) return { invoiceId: previous };
            const id = `in_${next()}`;
            invoices.set(id, { account, amount, currency });
            if (commandId !== undefined) invoiceFor.set(commandId, id);
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
        reportUsage: (args: {
          account: string;
          periodStart: DateTime.Utc;
          periodEnd: DateTime.Utc;
          lines: ReadonlyArray<UsageLine>;
          commandId: string;
        }) =>
          Effect.sync(() => {
            // The command id is the period: a redelivered close reaches the
            // same report, so the fake meters once like a real vendor does.
            const key = `${args.commandId}:${args.account}`;
            if (reported.has(key)) return {};
            reported.add(key);
            reports.push({
              account: args.account,
              periodStart: args.periodStart,
              periodEnd: args.periodEnd,
              lines: args.lines,
              commandId: args.commandId,
            });
            return {};
          }),
      };
    }),
  );
  const payments = Layer.merge(
    service,
    Layer.succeed(PaymentsProvider, { name: "memory", capabilities }),
  );

  return { name: "memory", kind: "memory", capabilities, payments, reports };
};
