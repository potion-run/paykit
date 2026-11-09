import * as Binding from "alchemy/Binding";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CurrencyMismatch } from "../Subscription/CurrencyMismatch.rejection.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import type { SubscriptionStatus } from "../Subscription/Subscription.state.ts";
import { TrialAlreadyUsed } from "../Subscription/TrialAlreadyUsed.rejection.ts";
import { TrialDeadlineNotLater } from "../Subscription/TrialDeadlineNotLater.rejection.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Start a trial on a tier, until a deadline the caller states. */
export interface StartTrialRequest {
  /** The tier the trial is on. Its price's interval decides the cadence. */
  readonly tier: string;
  /**
   * When the trial ends. It must be after now and, for an annual trial, the
   * converted period is annual: the deadline is the first period's end.
   */
  readonly trialEndsAt: DateTime.Utc;
  /** The account's period anchor. Defaults to UTC. */
  readonly anchorTz?: string;
  /** The currency to sell in. Omitted means the tier's base currency. */
  readonly currency?: string;
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** The standing the trial opened. */
export interface StartTrialResult {
  readonly tier: string;
  readonly status: SubscriptionStatus;
  /** The deadline the standing now carries. */
  readonly trialEndsAt: DateTime.Utc | null;
}

const refusals = [
  TrialAlreadyUsed,
  TrialDeadlineNotLater,
  PlanNotInCatalog,
  CatalogMismatch,
  CurrencyMismatch,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal a trial start can answer. */
export type StartTrialRefusal = InstanceType<(typeof refusals)[number]>;

export type StartTrialError = BindingError<StartTrialRefusal>;

/** Whether a failure is `StartTrial` refusing the request. */
export const isStartTrialRefusal = oneOf<StartTrialRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toStartTrialError = toBindingError("Paykit.StartTrial", isStartTrialRefusal);

/** The verb of a bound `StartTrial`. */
export type StartTrialVerb = (
  request: StartTrialRequest,
) => Effect.Effect<StartTrialResult, StartTrialError>;

/**
 * Open a trial on a tier. The trial opens on the cadence its price states, so an
 * annual trial converts into an annual period, and its deadline is the first
 * period's end — which is why a deadline behind the start is refused rather than
 * opening a period the next tick closes.
 *
 * A trial can be taken once per account: `TrialAlreadyUsed` is the second
 * attempt, not a bug. `ExtendTrial` is the admin command that moves a deadline
 * forward.
 *
 * ### Starting a fourteen-day trial
 * **Example:** A trial on a paid tier
 * ```typescript
 * const startTrial = yield* Paykit.StartTrial(account);
 * yield* startTrial({
 *   tier: "pro",
 *   trialEndsAt: DateTime.add(now, { days: 14 }),
 *   dedupeKey: requestId,
 * });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.StartTrial
 */
export interface StartTrial extends Binding.Service<
  StartTrial,
  "Paykit.StartTrial",
  (account: string) => Effect.Effect<StartTrialVerb>
> {}

export const StartTrial = Binding.Service<StartTrial>("Paykit.StartTrial");
