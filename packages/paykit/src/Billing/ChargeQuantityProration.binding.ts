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
  providerFor,
} from "../Payments.ts";
import { RecordQuantityProrationInvoice } from "../Subscription/QuantityProration.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
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
 * step that opens the provider invoice and records it. Only a positive `due` is
 * charged: a reduction's credit stays on the standing for the next period,
 * because paying money out is a refund, not a subscription action.
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
 * standing, asks the account's provider for one invoice keyed by the change,
 * and records the invoice on the log.
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

      const chosen = Option.match(router, {
        onNone: () => null,
        onSome: (set) => providerFor(set, state.refs),
      });

      const attempt = Effect.gen(function* () {
        const payments = yield* Effect.serviceOption(Payments);

        if (Option.isNone(payments)) {
          return yield* new ProviderCapabilityMissing({
            provider: chosen?.name ?? "none",
            op: "createInvoice",
          });
        }

        const commandId = `${account}:${request.prorationId}`;

        const { invoiceId } = yield* Option.getOrThrow(payments).createInvoice({
          account,
          amount: proration.due,
          currency: proration.currency,
          commandId,
        });

        yield* asSystem(
          subscription.send(
            ref,
            new RecordQuantityProrationInvoice({
              prorationId: request.prorationId,
              invoiceId,
              amount: proration.due,
              currency: proration.currency,
            }),
            { commandId: `quantity-proration:${commandId}` },
          ),
        );

        return {
          outcome: "charged",
          invoiceId,
          amount: proration.due,
          currency: proration.currency,
        } as const;
      });

      return chosen === null ? yield* attempt : yield* Effect.provide(attempt, chosen.payments);
    });
  },
);
