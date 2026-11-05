import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CurrencyMismatch } from "../Subscription/CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import type { AccountId } from "../Subscription/Subscription.state.ts";
import { TierNotInCatalog } from "../Subscription/TierNotInCatalog.rejection.ts";
import { NoTierChangeScheduled } from "../Subscription/WithdrawTierChange.command.ts";
import type { TierId } from "../Tier.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * Move to another tier when the period ends. The catalog is the layer's, so a
 * caller names the tier: price, allowances, credits and rates are joined here,
 * exactly as in `ChangeTier` — but no proration is computed, because nothing
 * moves until the boundary.
 */
export interface ScheduleTierChangeRequest {
  readonly tier: TierId;
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** Withdraw a scheduled change. */
export interface WithdrawTierChangeRequest {
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** The tier the standing will move to at the boundary, or `null` when nothing is scheduled. */
export interface PendingTierResult {
  readonly pendingTier: string | null;
}

const scheduleRefusals = [
  NotSubscribed,
  TierNotInCatalog,
  CurrencyMismatch,
  CatalogMismatch,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal a scheduled change can answer. */
export type ScheduleTierChangeRefusal = InstanceType<(typeof scheduleRefusals)[number]>;
export type ScheduleTierChangeError = BindingError<ScheduleTierChangeRefusal>;

/** Whether a failure is `ScheduleTierChange` refusing the request. */
export const isScheduleTierChangeRefusal = oneOf<ScheduleTierChangeRefusal>(scheduleRefusals);

/** A layer's own failure, as this binding's declared union. */
export const toScheduleTierChangeError = toBindingError(
  "Paykit.ScheduleTierChange",
  isScheduleTierChangeRefusal,
);

/** The verb of a bound `ScheduleTierChange`. */
export type ScheduleTierChangeVerb = (
  request: ScheduleTierChangeRequest,
) => Effect.Effect<PendingTierResult, ScheduleTierChangeError>;

const withdrawRefusals = [
  NotSubscribed,
  NoTierChangeScheduled,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal a withdrawal can answer. */
export type WithdrawTierChangeRefusal = InstanceType<(typeof withdrawRefusals)[number]>;
export type WithdrawTierChangeError = BindingError<WithdrawTierChangeRefusal>;

/** Whether a failure is `WithdrawTierChange` refusing the request. */
export const isWithdrawTierChangeRefusal = oneOf<WithdrawTierChangeRefusal>(withdrawRefusals);

/** A layer's own failure, as this binding's declared union. */
export const toWithdrawTierChangeError = toBindingError(
  "Paykit.WithdrawTierChange",
  isWithdrawTierChangeRefusal,
);

/** The verb of a bound `WithdrawTierChange`. */
export type WithdrawTierChangeVerb = (
  request: WithdrawTierChangeRequest,
) => Effect.Effect<PendingTierResult, WithdrawTierChangeError>;

/**
 * Schedule a tier change for the period boundary. This is the answer to a move
 * `ChangeTier` refuses — a smaller allowance than the period already used, or a
 * ceiling it has already passed — and to any move a caller wants to take effect
 * at the next invoice rather than now. The close applies it before the reset, so
 * the next period starts on the new tier's allowances.
 *
 * A second schedule replaces the first; `WithdrawTierChange` takes it back.
 *
 * ### Downgrading at the end of the month
 * **Example:** Move to a smaller plan at the boundary
 * ```typescript
 * const schedule = yield* Paykit.ScheduleTierChange(account);
 * const { pendingTier } = yield* schedule({ tier: "small" as TierId, dedupeKey: requestId });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.ScheduleTierChange
 */
export interface ScheduleTierChange extends Binding.Service<
  ScheduleTierChange,
  "Paykit.ScheduleTierChange",
  (account: AccountId) => Effect.Effect<ScheduleTierChangeVerb>
> {}

export const ScheduleTierChange = Binding.Service<ScheduleTierChange>("Paykit.ScheduleTierChange");

/**
 * Take a scheduled tier change back. Nothing was charged and nothing moved, so
 * this is the whole undo; a change that has already been applied belongs to
 * `ChangeTier`.
 *
 * ### Withdrawing a scheduled change
 * **Example:** Stay on the current tier
 * ```typescript
 * const withdraw = yield* Paykit.WithdrawTierChange(account);
 * yield* withdraw({ dedupeKey: requestId });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.WithdrawTierChange
 */
export interface WithdrawTierChange extends Binding.Service<
  WithdrawTierChange,
  "Paykit.WithdrawTierChange",
  (account: AccountId) => Effect.Effect<WithdrawTierChangeVerb>
> {}

export const WithdrawTierChange = Binding.Service<WithdrawTierChange>("Paykit.WithdrawTierChange");
