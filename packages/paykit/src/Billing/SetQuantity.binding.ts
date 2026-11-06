import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { PaymentDeclined, ProviderCapabilityMissing } from "../Payments.ts";
import type { Proration } from "../Proration.ts";
import { FeatureNotConsumable } from "../Subscription/FeatureNotConsumable.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import {
  QuantityCapExceeded,
  QuantityExceeded,
  QuantityInvalid,
} from "../Subscription/SetQuantity.command.ts";
import { StandingBlocksUsage } from "../Subscription/TrackUsage.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * A quantity to set, for a non-consumable feature. The bound account is not
 * here: `SetQuantity(account)` already fixed it.
 */
export interface SetQuantityRequest {
  /** The non-consumable feature, e.g. `seats`. */
  readonly feature: string;
  /** The total to hold, including the free grant. */
  readonly quantity: number;
  /**
   * The retry key. It is also the command id and the proration id, so a retry
   * records one change and bills one proration.
   */
  readonly dedupeKey: string;
}

/** What a quantity change left behind. */
export interface SetQuantityResult {
  /** The quantity the account holds after the change. */
  readonly quantity: number;
  /** What the change costs for the rest of the period, when it moves money. */
  readonly proration?: Proration;
}

const refusals = [
  NotSubscribed,
  FeatureNotConsumable,
  QuantityInvalid,
  QuantityCapExceeded,
  QuantityExceeded,
  StandingBlocksUsage,
  ProviderCapabilityMissing,
  PaymentDeclined,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal this command can answer. */
export type SetQuantityRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isSetQuantityRefusal = oneOf<SetQuantityRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toSetQuantityError = toBindingError("Paykit.SetQuantity", isSetQuantityRefusal);

/** Everything this binding can answer. */
export type SetQuantityError = BindingError<SetQuantityRefusal>;

/** The verb of a bound `SetQuantity`. */
export type SetQuantityVerb = (
  request: SetQuantityRequest,
) => Effect.Effect<SetQuantityResult, SetQuantityError>;

/**
 * Set a non-consumable feature's quantity. A seat is bought, not spent: the
 * command sets the total the account holds, prorates the difference for the
 * rest of the period, and records the pending charge under the request's
 * `dedupeKey`. `ChargeQuantityProration` collects it.
 *
 * ### Adding seats
 * **Example:** Move an account from 5 to 8 seats
 * ```typescript
 * const setQuantity = yield* Paykit.SetQuantity(account);
 * const { quantity, proration } = yield* setQuantity({
 *   feature: "seats",
 *   quantity: 8,
 *   dedupeKey: "seats:2026-11-06",
 * });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.SetQuantity
 */
export interface SetQuantity extends Binding.Service<
  SetQuantity,
  "Paykit.SetQuantity",
  (account: string) => Effect.Effect<SetQuantityVerb>
> {}

export const SetQuantity = Binding.Service<SetQuantity>("Paykit.SetQuantity");
