import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { asSystem } from "../Auth/Actor.ts";
import { Payments, PaymentsRouter, ProviderCapabilityMissing, providerFor } from "../Payments.ts";
import { NoProrationDue } from "../Subscription/RecordProrationInvoice.command.ts";
import { RecordProrationInvoice } from "../Subscription/RecordProrationInvoice.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";

/** Which account's unbilled tier change to collect. */
export interface ChargeProrationInput {
  readonly account: string;
}

/** What charging a proration did. */
export const ChargeProrationResult = Schema.Struct({
  /** `charged` when an invoice was opened; `nothing` when there was nothing to bill. */
  outcome: Schema.Literals(["charged", "nothing"]),
  invoiceId: Schema.optionalKey(Schema.String),
  /** Minor units. Present when something was charged. */
  amount: Schema.optionalKey(Schema.Int),
  currency: Schema.optionalKey(Schema.String),
});
export type ChargeProrationResult = typeof ChargeProrationResult.Type;

/**
 * Charge the money a mid-cycle tier change moved.
 *
 * `ChangeTier` records the proration its prices and period work out to, and
 * `Preview` shows it before anyone agrees. Neither collects it. This is the
 * step that does, and it is deliberately a binding rather than a model rule:
 * `decide` is pure, so the model can compute the amount but only an effect can
 * ask a provider for it.
 *
 * Three rules keep it honest:
 *
 * - **Only a positive `due` is charged.** A downgrade's credit is recorded and
 *   applied by the next period; paying money out is a refund, which is a
 *   provider action, not a subscription one.
 * - **Once.** The invoice id is stored by `RecordProrationInvoice`, and a second
 *   call returns `nothing` instead of opening a second invoice. The provider
 *   call carries a `commandId` keyed by the change, so a retry after a crash is
 *   the same invoice, not another one.
 * - **The log carries the money.** A charge the events cannot reproduce is a
 *   charge nobody can audit, so the invoice is a command with an event, not a
 *   side effect of `changeTier`.
 *
 * ### Collecting an upgrade
 * **Example:** Charge the difference after a tier change
 * ```typescript
 * yield* changeTier({ account, tier: "scale" });        // records the proration
 * const charged = yield* chargeProration({ account });  // opens the invoice
 * if (charged.outcome === "charged") notify(charged.invoiceId);
 * ```
 *
 * @primitive
 */
export const chargeProrationOperation = Effect.fn("Paykit.ChargeProration")(function* () {
  const subscription = yield* Subscription;
  const router = yield* Effect.serviceOption(PaymentsRouter);

  return Effect.fn("Paykit.ChargeProration.account")(function* (input: ChargeProrationInput) {
    const ref = Subscription.ref(input.account);
    const state = yield* subscription.state(ref);
    if (state._tag !== "Subscribed") {
      return yield* new NoProrationDue({ account: input.account, reason: "none" });
    }
    const proration = state.proration;
    if (proration === undefined || proration.due <= 0) {
      return yield* new NoProrationDue({ account: input.account, reason: "none" });
    }
    if (state.prorationInvoice !== undefined) {
      return yield* new NoProrationDue({ account: input.account, reason: "billed" });
    }
    // The change itself is the idempotency key. `TierChanged` gives every
    // prorated change a sequence number, so two identical changes in one period
    // are two charges, while a retry of either is the same one. State recorded
    // before the field existed falls back to the money and period it moved.
    const changeId =
      state.prorationId === undefined
        ? `${input.account}:${state.tier}:${state.period.start.epochMilliseconds}:${proration.due}:${proration.currency}`
        : `${input.account}:${state.period.start.epochMilliseconds}:${state.prorationId}`;
    // The invoice is collected by the provider the standing already belongs to.
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
      const { invoiceId } = yield* Option.getOrThrow(payments).createInvoice({
        account: input.account,
        amount: proration.due,
        currency: proration.currency,
        commandId: changeId,
      });
      // The receipt is keyed by the change, not the invoice it happened to
      // open, so a retry records the same charge rather than a second one.
      yield* asSystem(
        subscription.send(
          ref,
          new RecordProrationInvoice({
            invoiceId,
            amount: proration.due,
            currency: proration.currency,
          }),
          { commandId: `proration:${changeId}` },
        ),
      );
      return {
        outcome: "charged",
        invoiceId,
        amount: proration.due,
        currency: proration.currency,
      } as const satisfies ChargeProrationResult;
    });
    return chosen === null ? yield* attempt : yield* Effect.provide(attempt, chosen.payments);
  });
});
