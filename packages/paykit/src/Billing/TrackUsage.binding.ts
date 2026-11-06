import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import type { FeatureEntitlement } from "../Subscription/Entitlements.view.ts";
import { creditRateOf } from "../Subscription/Subscription.state.ts";
import {
  AllowanceExceeded,
  CreditExceeded,
  FeatureNotMetered,
  MoneyCapExceeded,
  SpendCapExceeded,
  StandingBlocksUsage,
} from "../Subscription/TrackUsage.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * One usage fact. The bound account is not here — `TrackUsage(account)` already
 * fixed it, so a request cannot name a second one.
 */
export interface TrackUsageRequest {
  /** The feature the work was measured in. */
  readonly feature: string;
  /** How many units it used. */
  readonly amount: number;
  /** Which rate prices it, for a credit-priced feature. Omitted means `"default"`. */
  readonly dimension?: string;
  /** The event's properties, which a rate card's rules and multipliers match. */
  readonly properties?: Readonly<Record<string, string>>;
  /**
   * The retry key. It is also the command id, so a transport that redelivers the
   * call records one usage fact rather than two.
   */
  readonly dedupeKey: string;
}

/**
 * The account's entitlement after the usage, read back from `Entitlements` so the
 * answer is the same over every transport. The per-event money (`charge`,
 * `billable`) stays on the event, where the timeline and the close read it; what
 * a caller needs here is what is left.
 */
export interface TrackUsageResult {
  /** Spendable after this usage. `null` means there is no count: unlimited, or a shared credit pool. */
  readonly remaining: number | null;
  /** The feature's units this period after this usage. */
  readonly used: number;
  /** Units held by open holds after this usage. */
  readonly reserved: number;
  /** The credit pool after this usage. */
  readonly credits: number;
  /** Credits this usage spent, `amount × rate`. Zero for a feature counted in its own units. */
  readonly cost: number;
  /** Money this feature has billed this period after this usage. Absent when the allowance has no price. */
  readonly billed?: number;
}

/**
 * The result of a `TrackUsage`, derived from the read model both layers wait on
 * rather than from one transport's reply. A feature that is not on the view means
 * no standing answered, which a command that succeeded cannot leave behind — the
 * zeros are the empty answer, not a guess.
 */
export const usageOutcome = (
  state: {
    readonly credits: number;
    readonly features: Readonly<Record<string, FeatureEntitlement>>;
  } | null,
  request: TrackUsageRequest,
): TrackUsageResult => {
  const feature = state?.features[request.feature];
  const rate =
    feature?.creditRates === undefined
      ? 0
      : creditRateOf(feature.creditRates, {
          dimension: request.dimension,
          properties: request.properties,
        });
  return {
    remaining: feature?.remaining ?? null,
    used: feature?.used ?? 0,
    reserved: feature?.reserved ?? 0,
    credits: state?.credits ?? 0,
    cost: rate === 0 ? 0 : request.amount * rate,
    ...(feature?.billed === undefined ? {} : { billed: feature.billed }),
  };
};

/**
 * A command the model understood and refused. The write did not happen, so a
 * caller may correct the request and send it again with the same `dedupeKey`.
 */
const refusals = [
  AllowanceExceeded,
  StandingBlocksUsage,
  FeatureNotMetered,
  CreditExceeded,
  SpendCapExceeded,
  MoneyCapExceeded,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal this command can answer, as the union the layer and the caller share. */
export type TrackUsageRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isTrackUsageRefusal = oneOf<TrackUsageRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toTrackUsageError = toBindingError("Paykit.TrackUsage", isTrackUsageRefusal);

/** Everything this binding can answer. */
export type TrackUsageError = BindingError<TrackUsageRefusal>;

/** The verb of a bound `TrackUsage`. */
export type TrackUsageVerb = (
  request: TrackUsageRequest,
) => Effect.Effect<TrackUsageResult, TrackUsageError>;

/**
 * Record usage in the same transaction that checks the allowance. A blocking
 * allowance refuses before anything is written; a `dedupeKey` makes a retry a
 * replay. This is the metered charge: it prices from the catalog and writes the
 * money on the event, and it never calls a provider — the period close is what
 * tells the vendor.
 *
 * The account is the bind and the request is the rest, so a second account is
 * not representable:
 *
 * ### Recording usage
 * **Example:** Meter one message, retried by the transport
 * ```typescript
 * const trackUsage = yield* Paykit.TrackUsage(account);
 *
 * yield* trackUsage({ feature: "messages", amount: 1, dedupeKey: requestId });
 * ```
 *
 * ### Holding capacity instead
 * Work that has started but not finished belongs in `Paykit.Hold`, which takes
 * the units now and bills only what ran.
 *
 * @binding
 * @product Usage
 * @provides Paykit.TrackUsage
 */
export interface TrackUsage extends Binding.Service<
  TrackUsage,
  "Paykit.TrackUsage",
  (account: string) => Effect.Effect<TrackUsageVerb>
> {}

export const TrackUsage = Binding.Service<TrackUsage>("Paykit.TrackUsage");
