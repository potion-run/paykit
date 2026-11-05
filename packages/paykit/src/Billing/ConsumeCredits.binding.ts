import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { CreditExceedsBalance } from "../Subscription/ConsumeCredits.command.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Credits to spend from the account's pool. */
export interface ConsumeCreditsRequest {
  /** How many credits. `Schema.Int`, so a fraction is a decode failure and not a silent round. */
  readonly amount: number;
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** The pool's balance after the spend, as the command's reply. */
export interface ConsumeCreditsResult {
  readonly balance: number;
}

const refusals = [NotSubscribed, CreditExceedsBalance, Unauthenticated, Forbidden] as const;

/** Every refusal this command can answer. */
export type ConsumeCreditsRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isConsumeCreditsRefusal = oneOf<ConsumeCreditsRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toConsumeCreditsError = toBindingError(
  "Paykit.ConsumeCredits",
  isConsumeCreditsRefusal,
);

/** Everything this binding can answer. */
export type ConsumeCreditsError = BindingError<ConsumeCreditsRefusal>;

/** The verb of a bound `ConsumeCredits`. */
export type ConsumeCreditsVerb = (
  request: ConsumeCreditsRequest,
) => Effect.Effect<ConsumeCreditsResult, ConsumeCreditsError>;

/**
 * Spend credits from the account's pool: one pool per account, whatever feature
 * the work belonged to. A spend past the balance is refused in the same
 * transaction, and the answer is the reply the command computed.
 *
 * This is the credits twin of {@link TrackUsage}: a metered feature is counted
 * in its own units, a credit-priced one spends `amount × rate`, and an explicit
 * spend is what a caller uses when it priced the work itself.
 *
 * ### Spending credits for work that has no meter
 * **Example:** A report generation that costs 40 credits
 * ```typescript
 * const consumeCredits = yield* Paykit.ConsumeCredits(account);
 * const { balance } = yield* consumeCredits({ amount: 40, dedupeKey: reportId });
 * ```
 *
 * @binding
 * @product Credits
 * @provides Paykit.ConsumeCredits
 */
export interface ConsumeCredits extends Binding.Service<
  ConsumeCredits,
  "Paykit.ConsumeCredits",
  (account: string) => Effect.Effect<ConsumeCreditsVerb>
> {}

export const ConsumeCredits = Binding.Service<ConsumeCredits>("Paykit.ConsumeCredits");
