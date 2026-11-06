import * as Binding from "alchemy/Binding";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { HoldExceeded } from "../Subscription/Hold.command.ts";
import {
  FeatureNotMetered,
  MoneyCapExceeded,
  SpendCapExceeded,
  StandingBlocksUsage,
} from "../Subscription/TrackUsage.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * Capacity to hold for work that has not finished. The bound account is not here.
 */
export interface HoldRequest {
  /** The feature the work is measured in. */
  readonly feature: string;
  /** How many units to hold. */
  readonly amount: number;
  /** Which rate prices them, for a credit-priced feature. */
  readonly dimension?: string;
  /** The event's properties, which a rate card's rules and multipliers match. */
  readonly properties?: Readonly<Record<string, string>>;
  /** How long the hold lives. Defaults on the model's clock to fifteen minutes. */
  readonly expiresAt?: DateTime.Utc;
  /**
   * The retry key, which is also the command id **and** the default hold id. A
   * retry therefore holds the same entity rather than a second one, and a settle
   * can address it without the caller having to remember which attempt landed.
   */
  readonly dedupeKey: string;
  /** Override the hold's id when it must be known before the call. */
  readonly holdId?: string;
}

/** What a hold answers: its id, and what the feature has left. */
export interface HoldResult {
  readonly holdId: string;
  /** Spendable after this hold. `null` means there is no count. */
  readonly remaining: number | null;
}

/** A hold past a blocking allowance, or past the pool, is refused in the same transaction. */
const refusals = [
  HoldExceeded,
  StandingBlocksUsage,
  FeatureNotMetered,
  SpendCapExceeded,
  MoneyCapExceeded,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal this command can answer, as the union the layer and the caller share. */
export type HoldRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isHoldRefusal = oneOf<HoldRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toHoldError = toBindingError("Paykit.Hold", isHoldRefusal);

/** Everything this binding can answer. */
export type HoldError = BindingError<HoldRefusal>;

/** The verb of a bound `Hold`. */
export type HoldVerb = (request: HoldRequest) => Effect.Effect<HoldResult, HoldError>;

/**
 * Hold capacity for work that has not finished: an agent turn, a long job, a
 * request whose cost is known up front. A hold has an id, so {@link SettleHold}
 * bills exactly that hold and {@link ReleaseHold} returns it — never whatever
 * else happens to be open on the feature.
 *
 * `dedupeKey` is the command id and the default hold id, so a retry holds once
 * and settles the entity it placed.
 *
 * ### Holding, then settling what ran
 * **Example:** Hold the cost of a turn, bill only what it used
 * ```typescript
 * const hold = yield* Paykit.Hold(account);
 * const { holdId } = yield* hold({ feature: "ai", amount: 1000, dimension: "gpt-large", dedupeKey: turnId });
 *
 * const used = yield* runTheTurn();
 * yield* settleHold({ holdId, amount: used, dedupeKey: `${turnId}:settle` });
 * ```
 *
 * @binding
 * @product Usage
 * @provides Paykit.Hold
 */
export interface Hold extends Binding.Service<
  Hold,
  "Paykit.Hold",
  (account: string) => Effect.Effect<HoldVerb>
> {}

export const Hold = Binding.Service<Hold>("Paykit.Hold");
