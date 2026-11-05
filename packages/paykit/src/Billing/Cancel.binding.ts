import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { AlreadyCanceled } from "../Subscription/AlreadyCanceled.rejection.ts";
import { NotScheduled } from "../Subscription/NotScheduled.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import type { AccountId } from "../Subscription/Subscription.state.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Both cancel and resume take nothing but their retry key. */
export interface CancelRequest {
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
}

/** Whether the standing now ends at the period boundary. */
export interface StandingResult {
  readonly cancelAtPeriodEnd: boolean;
}

const cancelRefusals = [NotSubscribed, AlreadyCanceled, Unauthenticated, Forbidden] as const;

/** Every refusal a cancellation can answer. */
export type CancelRefusal = InstanceType<(typeof cancelRefusals)[number]>;
export type CancelError = BindingError<CancelRefusal>;

/** Whether a failure is `ScheduleCancellation` refusing the request. */
export const isCancelRefusal = oneOf<CancelRefusal>(cancelRefusals);

/** A layer's own failure, as this binding's declared union. */
export const toCancelError = toBindingError("Paykit.ScheduleCancellation", isCancelRefusal);

/** The verb of a bound `ScheduleCancellation`. */
export type CancelVerb = (request: CancelRequest) => Effect.Effect<StandingResult, CancelError>;

const resumeRefusals = [NotSubscribed, NotScheduled, Unauthenticated, Forbidden] as const;

/** Every refusal a resume can answer. */
export type ResumeRefusal = InstanceType<(typeof resumeRefusals)[number]>;
export type ResumeError = BindingError<ResumeRefusal>;

/** Whether a failure is `Resume` refusing the request. */
export const isResumeRefusal = oneOf<ResumeRefusal>(resumeRefusals);

/** A layer's own failure, as this binding's declared union. */
export const toResumeError = toBindingError("Paykit.Resume", isResumeRefusal);

/** The verb of a bound `Resume`. */
export type ResumeVerb = (request: CancelRequest) => Effect.Effect<StandingResult, ResumeError>;

/**
 * End the standing at the period boundary. Nothing is billed for the time
 * after the close, and the account keeps what it bought until then — which is
 * why this is a schedule and not a destroy: money outlives the click.
 *
 * ### Scheduling a cancellation
 * **Example:** Cancel at the end of the month
 * ```typescript
 * const cancel = yield* Paykit.ScheduleCancellation(account);
 * const { cancelAtPeriodEnd } = yield* cancel({ dedupeKey: `cancel:${requestId}` });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.ScheduleCancellation
 */
export interface ScheduleCancellation extends Binding.Service<
  ScheduleCancellation,
  "Paykit.ScheduleCancellation",
  (account: AccountId) => Effect.Effect<CancelVerb>
> {}

export const ScheduleCancellation = Binding.Service<ScheduleCancellation>(
  "Paykit.ScheduleCancellation",
);

/**
 * Take a scheduled cancellation back. The standing keeps running to its next
 * boundary, so a resume before the close is the whole undo.
 *
 * ### Resuming
 * **Example:** Undo a cancellation
 * ```typescript
 * const resume = yield* Paykit.Resume(account);
 * yield* resume({ dedupeKey: `resume:${requestId}` });
 * ```
 *
 * @binding
 * @product Subscription
 * @provides Paykit.Resume
 */
export interface Resume extends Binding.Service<
  Resume,
  "Paykit.Resume",
  (account: AccountId) => Effect.Effect<ResumeVerb>
> {}

export const Resume = Binding.Service<Resume>("Paykit.Resume");
