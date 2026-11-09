import * as Binding from "alchemy/Binding";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import type { Balance } from "../Balance.ts";
import { FeatureNotConsumable } from "../Subscription/FeatureNotConsumable.rejection.ts";
import { FeaturePricedInCredits } from "../Subscription/FeaturePricedInCredits.rejection.ts";
import { FeatureNotCounted, GrantExpiryNotLater } from "../Subscription/GrantBalance.command.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { FeatureNotMetered } from "../Subscription/TrackUsage.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** A standalone grant of a counted feature. The bound account is not here. */
export interface GrantBalanceRequest {
  readonly featureId: string;
  /** How many units to grant. */
  readonly granted: number;
  /** An optional deadline; omitted, the grant never expires. */
  readonly expiresAt?: DateTime.Utc;
  /**
   * The retry key. Omitted, each call is its own command id; the aggregate
   * still records the grant once because a replay is keyed by the id.
   */
  readonly idempotencyKey?: string;
}

/** What the grant left behind. */
export interface GrantBalanceResult {
  readonly featureId: string;
  readonly granted: number;
  readonly balance: Balance;
}

const refusals = [
  NotSubscribed,
  FeatureNotConsumable,
  FeatureNotMetered,
  FeaturePricedInCredits,
  FeatureNotCounted,
  GrantExpiryNotLater,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal this command can answer, as the union the layer and the caller share. */
export type GrantBalanceRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isGrantBalanceRefusal = oneOf<GrantBalanceRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toGrantBalanceError = toBindingError("Paykit.GrantBalance", isGrantBalanceRefusal);

/** Everything this binding can answer. */
export type GrantBalanceError = BindingError<GrantBalanceRefusal>;

/** The verb of a bound `GrantBalance`. */
export type GrantBalanceVerb = (
  request: GrantBalanceRequest,
) => Effect.Effect<GrantBalanceResult, GrantBalanceError>;

/**
 * Create a standalone grant of a counted feature: the API behind
 * `Paykit.Balances(account).create`. A grant belongs to the customer, not to a
 * plan — the plan and rollover sources are spent first, and a lifetime grant
 * survives every close and plan change (ADR 0037).
 *
 * ### Granting 50 research runs
 * **Example:** Goodwill with an expiry
 * ```typescript
 * const grant = yield* Paykit.GrantBalance(account);
 * yield* grant({
 *   featureId: "research_runs",
 *   granted: 50,
 *   expiresAt: DateTime.add(DateTime.unsafeNow(), { months: 1 }),
 * });
 * ```
 *
 * @binding
 * @product Usage
 * @provides Paykit.GrantBalance
 */
export interface GrantBalance extends Binding.Service<
  GrantBalance,
  "Paykit.GrantBalance",
  (account: string) => Effect.Effect<GrantBalanceVerb>
> {}

export const GrantBalance = Binding.Service<GrantBalance>("Paykit.GrantBalance");
