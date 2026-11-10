import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { asSystem } from "../Auth/Actor.ts";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import {
  type PaymentError,
  Payments,
  PaymentsRouter,
  PaymentDeclined,
  ProviderCapabilityMissing,
  resolveProvider,
} from "../Payments.ts";
import {
  RecordQuantityProrationInvoice,
  ApplyQuantityCredit,
} from "../Subscription/QuantityProration.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import { quantityCreditUsesOf, quantityCreditsOf } from "../Subscription/Subscription.state.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Which pending quantity change to collect. */
export interface ChargeQuantityProrationRequest {
  /** The `dedupeKey` the `SetQuantity` recorded. */
  readonly prorationId: string;
}

/** What charging a quantity proration did. */
export interface ChargeQuantityProrationResult {
  /** `charged` when an invoice was opened; `nothing` when there was nothing to bill. */
  readonly outcome: "charged" | "nothing";
  readonly invoiceId?: string;
  /** Minor units. Present when something was charged. */
  readonly amount?: number;
  readonly currency?: string;
  /** Minor units of the charge the account's credits covered (ADR 0042). */
  readonly creditApplied?: number;
}

const refusals = [ProviderCapabilityMissing, PaymentDeclined, Unauthenticated, Forbidden] as const;

/** Every refusal collecting a quantity proration can answer. */
export type ChargeQuantityProrationRefusal = InstanceType<(typeof refusals)[number]>;

export type ChargeQuantityProrationError = BindingError<
  ChargeQuantityProrationRefusal | PaymentError
>;

/** Whether a failure is the provider refusing to open the invoice. */
export const isChargeQuantityProrationRefusal = oneOf<ChargeQuantityProrationRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toChargeQuantityProrationError = toBindingError(
  "Paykit.ChargeQuantityProration",
  isChargeQuantityProrationRefusal,
);

/** The verb of a bound `ChargeQuantityProration`. */
export type ChargeQuantityProrationVerb = (
  request: ChargeQuantityProrationRequest,
) => Effect.Effect<ChargeQuantityProrationResult, ChargeQuantityProrationError>;

/**
 * Collect the money a quantity change moved.
 *
 * `SetQuantity` records the proration and the key that owns it; this is the
 * step that opens the provider invoice and records it. A positive `due` is
 * collected, and the account's quantity credits are spent against it first: the
 * invoice opens for the net, so a reduction from an earlier period settles here
 * instead of being paid out as cash (ADR 0042). A credit larger than the charge
 * leaves a remainder for a later one; a credit that covers the charge fully
 * records the application and opens no invoice.
 *
 * ### Collecting a seat increase
 * **Example:** Charge the difference after adding seats
 * ```typescript
 * const setQuantity = yield* Paykit.SetQuantity(account);
 * const { proration } = yield* setQuantity({
 *   feature: "seats",
 *   quantity: 8,
 *   dedupeKey: "seats:2026-11-06",
 * });
 * if (proration !== undefined && proration.due > 0) {
 *   yield* (yield* Paykit.ChargeQuantityProration(account))({
 *     prorationId: "seats:2026-11-06",
 *   });
 * }
 * ```
 *
 * @binding
 * @product Payments
 * @provides Paykit.ChargeQuantityProration
 */
export interface ChargeQuantityProration extends Binding.Service<
  ChargeQuantityProration,
  "Paykit.ChargeQuantityProration",
  (account: string) => Effect.Effect<ChargeQuantityProrationVerb>
> {}

export const ChargeQuantityProration = Binding.Service<ChargeQuantityProration>(
  "Paykit.ChargeQuantityProration",
);

/**
 * The operation behind the binding. It reads the pending proration from the
 * standing, spends the account's credits against it, asks the account's
 * provider for one invoice for the net keyed by the change, and records the
 * invoice on the log.
 */
export const chargeQuantityProrationOperation = Effect.fn("Paykit.ChargeQuantityProration")(
  function* () {
    const subscription = yield* Subscription;
    const router = yield* Effect.serviceOption(PaymentsRouter);

    return Effect.fn("Paykit.ChargeQuantityProration.account")(function* (
      account: string,
      request: ChargeQuantityProrationRequest,
    ) {
      const ref = Subscription.ref(account);
      const state = yield* subscription.state(ref);

      if (state._tag !== "Subscribed") return { outcome: "nothing" } as const;
      const entry = state.quantityProrations?.[request.prorationId];

      if (entry === undefined || entry.invoiceId !== undefined) {
        return { outcome: "nothing" } as const;
      }

      const proration = entry.proration;

      if (proration.due <= 0) return { outcome: "nothing" } as const;

      // Spend the credits the account holds before opening the bill. The
      // application is capped by the charge, so the remainder stays on its own
      // entry for a later one (ADR 0042).
      const uses = quantityCreditUsesOf(
        proration.due,
        quantityCreditsOf(state, proration.currency, request.prorationId),
      );

      const creditApplied = uses.reduce((sum, use) => sum + use.amount, 0);
      const owed = proration.due - creditApplied;

      const chosen = Option.match(router, {
        onNone: () => null,
        onSome: (set) => resolveProvider(set, state.refs),
      });

      const commandId = `${account}:${request.prorationId}`;

      const applyCredit =
        creditApplied === 0
          ? Effect.void
          : asSystem(
              subscription.send(
                ref,
                new ApplyQuantityCredit({ prorationId: request.prorationId }),
                { commandId: `quantity-credit:${commandId}` },
              ),
            );

      // The credit is spent against the charge even when it covers it fully:
      // the charge is settled, and no invoice is opened for zero.
      if (owed === 0) {
        yield* applyCredit;

        return {
          outcome: "nothing",
          creditApplied,
          currency: proration.currency,
        } as const;
      }

      const attempt = Effect.gen(function* () {
        yield* applyCredit;

        const payments = yield* Effect.serviceOption(Payments);

        if (Option.isNone(payments)) {
          return yield* new ProviderCapabilityMissing({
            provider: chosen?.provider.name ?? "none",
            op: "createInvoice",
          });
        }

        const { invoiceId } = yield* Option.getOrThrow(payments).createInvoice({
          account,
          amount: owed,
          currency: proration.currency,
          commandId,
        });

        yield* asSystem(
          subscription.send(
            ref,
            new RecordQuantityProrationInvoice({
              prorationId: request.prorationId,
              invoiceId,
              amount: owed,
              currency: proration.currency,
            }),
            { commandId: `quantity-proration:${commandId}` },
          ),
        );

        return {
          outcome: "charged",
          invoiceId,
          amount: owed,
          currency: proration.currency,
          ...(creditApplied === 0 ? {} : { creditApplied }),
        } as const;
      });

      return chosen === null ? yield* attempt : yield* Effect.provide(attempt, chosen.context);
    });
  },
);
