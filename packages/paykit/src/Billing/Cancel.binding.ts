import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { planTermsOf, type Catalog } from "../Catalog.ts";
import { AlreadyCanceled } from "../Subscription/AlreadyCanceled.rejection.ts";
import { DefaultPlanNotCancelable, PlanGroupEmpty } from "../Subscription/CancelGroup.command.ts";
import { NotScheduled } from "../Subscription/NotScheduled.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import type { PlanRow } from "../Subscription/PlanSet.ts";
import { StandingEnded } from "../Subscription/StandingEnded.rejection.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * The default plan of a group, with the terms the boundary needs. A group that
 * states none returns `undefined`, which is what makes its cancellation empty
 * the group rather than invent a plan (ADR 0039 §5).
 *
 * A custom plan may be a group's default (ADR 0043): the row is built from
 * `planTermsOf`, so a cancellation re-grants the catalog's grants, price,
 * credits, expiry and rates — what the catalogue quotes to everyone — never the
 * bespoke set a customer held. An add-on fills no group, so it is never a
 * fallback.
 */
export const defaultPlanFor = (
  catalog: Catalog,
  group: string,
  currency?: string,
): PlanRow | undefined => {
  const tier = catalog.tiers.find(
    (candidate) =>
      candidate.addOn !== true &&
      (candidate.group ?? "default") === group &&
      candidate.isDefault === true,
  );

  if (tier === undefined) return undefined;
  const terms = planTermsOf(catalog, tier.id, currency);

  return terms === null
    ? undefined
    : {
        planId: tier.id,
        group,
        addOn: false,
        allowances: terms.allowances,
        credits: terms.credits,
        creditsExpire: terms.creditsExpire,
        ...(terms.topUp === undefined ? {} : { topUp: terms.topUp }),
        rates: terms.rates,
        ...(terms.price?.interval === undefined ? {} : { interval: terms.price.interval }),
        ...(terms.price?.currency === undefined ? {} : { currency: terms.price.currency }),
        ...(terms.price === undefined ? {} : { price: terms.price }),
      };
};

/** Both cancel and resume take a retry key and, optionally, one group. */
export interface CancelRequest {
  /** The retry key, which is also the command id. */
  readonly dedupeKey: string;
  /**
   * The group to cancel or resume. Absent means the whole standing, which is
   * the whole-account cancellation a deployment without groups still uses.
   */
  readonly group?: string;
}

/** Whether the standing now ends at the period boundary. */
export interface StandingResult {
  readonly cancelAtPeriodEnd: boolean;
  /** The group a group-level cancellation named; absent for the whole account. */
  readonly group?: string;
}

const cancelRefusals = [
  NotSubscribed,
  StandingEnded,
  AlreadyCanceled,
  DefaultPlanNotCancelable,
  PlanGroupEmpty,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal a cancellation can answer. */
export type CancelRefusal = InstanceType<(typeof cancelRefusals)[number]>;

export type CancelError = BindingError<CancelRefusal>;

/** Whether a failure is `ScheduleCancellation` refusing the request. */
export const isCancelRefusal = oneOf<CancelRefusal>(cancelRefusals);

/** A layer's own failure, as this binding's declared union. */
export const toCancelError = toBindingError("Paykit.ScheduleCancellation", isCancelRefusal);

/** The verb of a bound `ScheduleCancellation`. */
export type CancelVerb = (request: CancelRequest) => Effect.Effect<StandingResult, CancelError>;

const resumeRefusals = [
  NotSubscribed,
  StandingEnded,
  NotScheduled,
  Unauthenticated,
  Forbidden,
] as const;

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
  (account: string) => Effect.Effect<CancelVerb>
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
  (account: string) => Effect.Effect<ResumeVerb>
> {}

export const Resume = Binding.Service<Resume>("Paykit.Resume");
