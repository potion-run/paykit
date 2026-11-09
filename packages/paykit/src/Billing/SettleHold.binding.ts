import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import type { Balance } from "../Balance.ts";
import {
  HoldExceeded,
  HoldExpired,
  HoldSettled,
  HoldUnknown,
} from "../Subscription/Hold.command.ts";
import { MoneyCapExceeded, StandingBlocksUsage } from "../Subscription/TrackUsage.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Settle a hold, billing `amount` of it and returning the rest. */
export interface SettleHoldRequest {
  /** The hold this settle is about. */
  readonly holdId: string;
  /** Units to bill. Omitted bills the whole hold. */
  readonly amount?: number;
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** What the command billed and what it returned, as its reply. */
export interface SettleHoldResult {
  readonly billed: number;
  /** The feature the hold was taken on, so `Balances.finalize` can answer it. */
  readonly featureId: string;
  readonly released: number;
  /** The feature's balance after the settle. */
  readonly balance: Balance;
}

/** Refusals a settle can answer: an unknown, closed, or over-settled hold. */
const refusals = [
  HoldUnknown,
  HoldSettled,
  HoldExpired,
  HoldExceeded,
  StandingBlocksUsage,
  MoneyCapExceeded,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal this command can answer, as the union the layer and the caller share. */
export type SettleHoldRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isSettleHoldRefusal = oneOf<SettleHoldRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toSettleHoldError = toBindingError("Paykit.SettleHold", isSettleHoldRefusal);

/** Everything this binding can answer. */
export type SettleHoldError = BindingError<SettleHoldRefusal>;

/** The verb of a bound `SettleHold`. */
export type SettleHoldVerb = (
  request: SettleHoldRequest,
) => Effect.Effect<SettleHoldResult, SettleHoldError>;

/**
 * Turn a hold into usage: bill what ran and return the rest, in the same command.
 *
 * Settling an already settled hold records nothing, so a retry bills once; a
 * released or expired hold is a typed refusal. The answer is the command's own
 * reply — the units it billed and the units it returned — so it is the same
 * number over every transport.
 *
 * ### Settling what a turn used
 * **Example:** Two calls, never three
 * ```typescript
 * const settleHold = yield* Paykit.SettleHold(account);
 * yield* settleHold({ holdId, amount: tokensUsed, dedupeKey: `${turnId}:settle` });
 * // released is the units the hold kept and the turn did not spend
 * ```
 *
 * @binding
 * @product Usage
 * @provides Paykit.SettleHold
 */
export interface SettleHold extends Binding.Service<
  SettleHold,
  "Paykit.SettleHold",
  (account: string) => Effect.Effect<SettleHoldVerb>
> {}

export const SettleHold = Binding.Service<SettleHold>("Paykit.SettleHold");
