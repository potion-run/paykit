import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { HoldSettled, HoldUnknown } from "../Subscription/Hold.command.ts";
import type { AccountId } from "../Subscription/Subscription.state.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Return a hold without billing any of it. */
export interface ReleaseHoldRequest {
  /** The hold to return. */
  readonly holdId: string;
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** What a release returned. */
export interface ReleaseHoldResult {
  readonly released: number;
}

/** A released hold is an unknown one, or one already settled. */
const refusals = [HoldUnknown, HoldSettled, Unauthenticated, Forbidden] as const;

/** Every refusal this command can answer, as the union the layer and the caller share. */
export type ReleaseHoldRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isReleaseHoldRefusal = oneOf<ReleaseHoldRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toReleaseHoldError = toBindingError("Paykit.ReleaseHold", isReleaseHoldRefusal);

/** Everything this binding can answer. */
export type ReleaseHoldError = BindingError<ReleaseHoldRefusal>;

/** The verb of a bound `ReleaseHold`. */
export type ReleaseHoldVerb = (
  request: ReleaseHoldRequest,
) => Effect.Effect<ReleaseHoldResult, ReleaseHoldError>;

/**
 * Return a hold without billing it: the work failed, was cancelled, or never
 * ran. Releasing after `expiresAt` still returns the units, because a late
 * release is a cleanup and not a charge.
 *
 * ### Returning capacity
 * **Example:** A turn that produced nothing
 * ```typescript
 * const releaseHold = yield* Paykit.ReleaseHold(account);
 * yield* releaseHold({ holdId, dedupeKey: `${turnId}:release` });
 * ```
 *
 * @binding
 * @product Usage
 * @provides Paykit.ReleaseHold
 */
export interface ReleaseHold extends Binding.Service<
  ReleaseHold,
  "Paykit.ReleaseHold",
  (account: AccountId) => Effect.Effect<ReleaseHoldVerb>
> {}

export const ReleaseHold = Binding.Service<ReleaseHold>("Paykit.ReleaseHold");
