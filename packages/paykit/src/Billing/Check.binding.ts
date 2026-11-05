import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import type { CheckResult } from "../Check.ts";
import type { AccountId } from "../Subscription/Subscription.state.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * What an account asks before doing work. The bound account is not here;
 * `Check(account)` fixed it.
 */
export interface CheckRequest {
  /** The feature the work needs. */
  readonly feature: string;
  /** How much the work will consume. Defaults to 1. */
  readonly amount?: number;
  /** Which rate prices it, for a credit-priced feature. */
  readonly dimension?: string;
}

/** Everything `Check` can answer. A read refuses nothing but a guard. */
const refusals = [Unauthenticated, Forbidden] as const;

/** Every refusal this command can answer, as the union the layer and the caller share. */
export type CheckRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isCheckRefusal = oneOf<CheckRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toCheckError = toBindingError("Paykit.Check", isCheckRefusal);

/** Everything this binding can answer. */
export type CheckError = BindingError<CheckRefusal>;

/** The verb of a bound `Check`. */
export type CheckVerb = (request: CheckRequest) => Effect.Effect<CheckResult, CheckError>;

/**
 * The entitlement plane: one local read, no provider round trip. `Check` never
 * records usage — `TrackUsage` is the write, and it judges the allowance in the
 * transaction that records it. Asking before acting is how a caller shows a
 * price, not how it protects a quota: that protection is `TrackUsage` refusing,
 * or `Hold` reserving.
 *
 * ### Asking before doing work
 * **Example:** Meter a feature whose allowance blocks
 * ```typescript
 * const check = yield* Paykit.Check(account);
 * const answer = yield* check({ feature: "messages", amount: 1 });
 * if (!answer.allowed) return showUpgrade(answer.standing, answer.resetsAt);
 * ```
 *
 * ### Holding what the work will cost
 * Work that has already started belongs in `Paykit.Hold`, which reserves the
 * units so a second caller cannot spend them.
 *
 * @binding
 * @product Usage
 * @provides Paykit.Check
 */
export interface Check extends Binding.Service<
  Check,
  "Paykit.Check",
  (account: AccountId) => Effect.Effect<CheckVerb>
> {}

export const Check = Binding.Service<Check>("Paykit.Check");
