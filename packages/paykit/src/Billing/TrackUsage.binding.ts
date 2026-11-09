import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { type Balance, balanceOfScope, emptyBalance } from "../Balance.ts";
import { CUSTOMER_SCOPE, EntityId, entityScope } from "../Customer.ts";
import type { EntitlementsState } from "../Subscription/Entitlements.view.ts";
import { EntityArchived } from "../Subscription/EntityArchived.rejection.ts";
import { EntityUnknown } from "../Subscription/EntityUnknown.rejection.ts";
import { SpendLimitExceeded } from "../Subscription/SpendLimitExceeded.rejection.ts";
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
  readonly featureId: string;
  /** The entity scope that spent the units; absent means the customer. */
  readonly entityId?: EntityId;
  /** How many units it used. */
  readonly value: number;
  /** Which rate prices it, for a credit-priced feature. Omitted means `"default"`. */
  readonly dimension?: string;
  /** The event's properties, which a rate card's rules and multipliers match. */
  readonly properties?: Readonly<Record<string, string>>;
  /**
   * The retry key. It is also the command id, so a transport that redelivers the
   * call records one usage fact rather than two.
   */
  readonly idempotencyKey: string;
}

/**
 * What the usage left behind, read back from `Entitlements` so the answer is the
 * same over every transport. The per-event money (`charge`, `billable`) stays on
 * the event, where the timeline and the close read it; what a caller needs here
 * is the balance.
 */
export interface TrackUsageResult {
  readonly customerId: string;
  readonly featureId: string;
  /** The units this call recorded. */
  readonly value: number;
  /** What the customer has left of the feature, with its sources. */
  readonly balance: Balance;
}

/**
 * The result of a `TrackUsage`, derived from the read model both layers wait on
 * rather than from one transport's reply. A feature that is not on the view means
 * no standing answered, which a command that succeeded cannot leave behind — an
 * empty balance is the zero answer, not a guess.
 */
export const usageOutcome = (
  state: EntitlementsState | null,
  account: string,
  request: TrackUsageRequest,
): TrackUsageResult => {
  const balance =
    state === null ? null : balanceOfScope(state, request.featureId, request.entityId);

  return {
    customerId: account,
    featureId: request.featureId,
    value: request.value,
    balance:
      balance ??
      emptyBalance(
        account,
        request.featureId,
        request.entityId === undefined ? CUSTOMER_SCOPE : entityScope(request.entityId),
      ),
  };
};

/**
 * A command the model understood and refused. The write did not happen, so a
 * caller may correct the request and send it again with the same `idempotencyKey`.
 */
const refusals = [
  EntityUnknown,
  EntityArchived,
  AllowanceExceeded,
  StandingBlocksUsage,
  FeatureNotMetered,
  CreditExceeded,
  SpendCapExceeded,
  MoneyCapExceeded,
  SpendLimitExceeded,
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
 * allowance refuses before anything is written; an `idempotencyKey` makes a
 * retry a replay. This is the metered charge: it prices from the catalog and
 * writes the money on the event, and it never calls a provider — the period
 * close is what tells the vendor.
 *
 * The account is the bind and the request is the rest, so a second account is
 * not representable:
 *
 * ### Recording usage
 * **Example:** Meter one message, retried by the transport
 * ```typescript
 * const trackUsage = yield* Paykit.TrackUsage(account);
 *
 * yield* trackUsage({ featureId: "messages", value: 1, idempotencyKey: requestId });
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
