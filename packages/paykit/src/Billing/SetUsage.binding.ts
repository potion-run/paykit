import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import type { Balance } from "../Balance.ts";
import { FeatureNotConsumable } from "../Subscription/FeatureNotConsumable.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { UsageInvalid } from "../Subscription/SetUsage.command.ts";
import { StandingBlocksUsage } from "../Subscription/TrackUsage.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** The occupancy of one non-consumable feature. The bound account is not here. */
export interface SetUsageRequest {
  /** The non-consumable feature, e.g. `seats`. */
  readonly featureId: string;
  /** How many are in use. A count, not a purchase and not a spend. */
  readonly usage: number;
  /**
   * The retry key. Omitted, each call is its own command id and the model still
   * records nothing when the occupancy is unchanged, so a retry is one fact.
   */
  readonly idempotencyKey?: string;
}

/** What an occupancy change left behind. */
export interface SetUsageResult {
  readonly featureId: string;
  /** The number in use after the change. */
  readonly usage: number;
  /** `purchased - usage`; negative when occupancy is above the purchase. */
  readonly remaining: number;
  /** The feature's balance after the write. */
  readonly balance: Balance;
}

const refusals = [
  NotSubscribed,
  FeatureNotConsumable,
  UsageInvalid,
  StandingBlocksUsage,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal this command can answer, as the union the layer and the caller share. */
export type SetUsageRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isSetUsageRefusal = oneOf<SetUsageRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toSetUsageError = toBindingError("Paykit.SetUsage", isSetUsageRefusal);

/** Everything this binding can answer. */
export type SetUsageError = BindingError<SetUsageRefusal>;

/** The verb of a bound `SetUsage`. */
export type SetUsageVerb = (
  request: SetUsageRequest,
) => Effect.Effect<SetUsageResult, SetUsageError>;

/**
 * Set how much of a non-consumable feature is in use. A seat is occupied, not
 * spent: this never bills, never resets at a boundary and never changes the
 * purchased quantity (ADR 0036).
 *
 * Occupancy may exceed the purchase. `check()` then answers `allowed: false`
 * for a new seat while the people already using one keep working.
 *
 * ### Occupying seats
 * **Example:** Sync the workspace's member count
 * ```typescript
 * const setUsage = yield* Paykit.SetUsage(account);
 * const { remaining } = yield* setUsage({ featureId: "seats", usage: members.length });
 * if (remaining < 0) promptToBuySeats(-remaining);
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.SetUsage
 */
export interface SetUsage extends Binding.Service<
  SetUsage,
  "Paykit.SetUsage",
  (account: string) => Effect.Effect<SetUsageVerb>
> {}

export const SetUsage = Binding.Service<SetUsage>("Paykit.SetUsage");
