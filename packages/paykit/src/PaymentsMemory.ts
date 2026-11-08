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
  "charge",
  "refund",
  "portal",
  "usage",
  "quantity",
]);

/** One charge the memory provider took. */
export interface MemoryCharge {
  readonly chargeId: string;
  readonly account: string;
  readonly amount: number;
  readonly currency: string;
  readonly commandId?: string;
}

/** One quantity the memory provider set on a subscription. */
export interface MemoryQuantityChange {
  readonly account: string;
  readonly subscription: string;
  readonly tier: string;
  readonly feature: string;
  readonly quantity: number;
  readonly proration: "immediate" | "none";
  readonly commandId: string;
}

/** One refund the memory provider took. */
export interface MemoryRefund {
  readonly refundId: string;
  readonly chargeId: string;
  readonly amount: number;
  readonly commandId?: string;
}

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
  /** Every charge it took, so a test can tell a charge from an invoice. */
  readonly charges: ReadonlyArray<MemoryCharge>;
  /** Every refund it took, so a test can read the money back out. */
  readonly refunds: ReadonlyArray<MemoryRefund>;
  /** Every quantity change it accepted, so a test can tell the vendor saw it. */
  readonly quantities: ReadonlyArray<MemoryQuantityChange>;
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
  const charges: Array<MemoryCharge> = [];
  /** The charge a command id already took, for the same reason. */
  const chargeFor = new Map<string, string>();
  const refunds: Array<MemoryRefund> = [];
  const quantities: Array<MemoryQuantityChange> = [];
  /** The refund a command id already took, for the same reason. */
  const refundFor = new Map<string, string>();
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
        }) => {
          if (amount <= 0) {
            return Effect.fail(
              new PaymentDeclined({
                provider: "memory",
                code: "invalid_amount",
                message: "a charge needs a positive amount",
              }),
            );
          }

          return Effect.sync(() => {
            const previous = commandId === undefined ? undefined : chargeFor.get(commandId);

            if (previous !== undefined) return { chargeId: previous };
            const chargeId = `ch_${next()}`;
            charges.push({
              chargeId,
              account,
              amount,
              currency,
              ...(commandId === undefined ? {} : { commandId }),
            });

            if (commandId !== undefined) chargeFor.set(commandId, chargeId);

            return { chargeId };
          });
        },
        refund: ({
          chargeId,
          amount,
          commandId,
        }: {
          chargeId: string;
          amount: number;
          commandId?: string;
        }) =>
          Effect.sync(() => {
            // The dedupe key is the operator's: a retried refund command is the
            // refund that already went back, not a second one.
            const previous = commandId === undefined ? undefined : refundFor.get(commandId);

            if (previous !== undefined) return { refundId: previous };
            const refundId = `re_${next()}`;
            refunds.push({
              refundId,
              chargeId,
              amount,
              ...(commandId === undefined ? {} : { commandId }),
            });

            if (commandId !== undefined) refundFor.set(commandId, refundId);

            return { refundId };
          }),
        createPortal: ({ account }: { account: string }) =>
          Effect.succeed({
            url: `https://paykit.memory/portal/${encodeURIComponent(account)}`,
          }),
        setQuantity: (args: {
          account: string;
          subscription: string;
          tier: string;
          feature: string;
          quantity: number;
          proration: "immediate" | "none";
          commandId: string;
        }) =>
          Effect.sync(() => {
            const previous = quantities.find((change) => change.commandId === args.commandId);

            if (previous === undefined) quantities.push(args);

            // An immediate proration opens an invoice; `none` defers it.
            return args.proration === "immediate" ? { invoiceId: `in_${next()}` } : {};
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

  return {
    name: "memory",
    kind: "memory",
    capabilities,
    payments,
    reports,
    charges,
    refunds,
    quantities,
  };
};
