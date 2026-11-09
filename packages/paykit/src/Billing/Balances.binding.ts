import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import type { Balance } from "../Balance.ts";
import { FeatureNotConsumable } from "../Subscription/FeatureNotConsumable.rejection.ts";
import {
  FeatureNotCounted,
  FeaturePricedInCredits,
  GrantExpiryNotLater,
} from "../Subscription/GrantBalance.command.ts";
import {
  HoldExceeded,
  HoldExpired,
  HoldSettled,
  HoldUnknown,
} from "../Subscription/Hold.command.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import { UsageInvalid } from "../Subscription/SetUsage.command.ts";
import { SpendLimitExceeded } from "../Subscription/SpendLimitExceeded.rejection.ts";
import {
  FeatureNotMetered,
  MoneyCapExceeded,
  StandingBlocksUsage,
} from "../Subscription/TrackUsage.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Ask for one feature's balance. The bound account is not here. */
export const BalanceGetRequest = Schema.Struct({
  featureId: Schema.String,
});

export type BalanceGetRequest = typeof BalanceGetRequest.Type;

/** Set how much of a non-consumable feature is in use. */
export const BalanceUpdateRequest = Schema.Struct({
  featureId: Schema.String,
  /** The number in use. A count, not a purchase and not a spend. */
  usage: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The retry key. Omitted, it is derived from the feature and the count. */
  idempotencyKey: Schema.optionalKey(Schema.String),
});

export type BalanceUpdateRequest = typeof BalanceUpdateRequest.Type;

/** Create a standalone grant of a counted feature. */
export const BalanceCreateRequest = Schema.Struct({
  featureId: Schema.String,
  /** How many units to grant. */
  grantedBalance: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  /** An optional deadline; omitted, the grant is a lifetime source. */
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  /**
   * The public spelling of a lifetime grant: `{ interval: "one_off" }` (or
   * `"never"`). A resetting standalone grant is an add-on plan item (Phase 5).
   */
  reset: Schema.optionalKey(
    Schema.Struct({
      interval: Schema.Literals(["one_off", "never"]),
    }),
  ),
  /** The retry key. Omitted, each call is its own grant id. */
  idempotencyKey: Schema.optionalKey(Schema.String),
});

export type BalanceCreateRequest = typeof BalanceCreateRequest.Type;

/** Finish a lock: bill what ran, or return it. */
export const BalanceFinalizeRequest = Schema.Struct({
  lockId: Schema.String,
  action: Schema.Literals(["commit", "release"]),
  /** Units to bill. Omitted on `commit` bills the whole lock. */
  overrideValue: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
});

export type BalanceFinalizeRequest = typeof BalanceFinalizeRequest.Type;

/** The customer has no balance for the feature. */
export class BalanceNotFound extends Schema.TaggedError<BalanceNotFound>()("BalanceNotFound", {
  customerId: Schema.String,
  featureId: Schema.String,
}) {}

/**
 * What a `Balances` verb can answer: the same refusals as the command behind it,
 * plus a feature this customer has no balance for.
 */
const refusals = [
  BalanceNotFound,
  NotSubscribed,
  FeatureNotConsumable,
  FeatureNotMetered,
  FeaturePricedInCredits,
  FeatureNotCounted,
  GrantExpiryNotLater,
  UsageInvalid,
  StandingBlocksUsage,
  MoneyCapExceeded,
  SpendLimitExceeded,
  HoldUnknown,
  HoldSettled,
  HoldExpired,
  HoldExceeded,
  Unauthenticated,
  Forbidden,
] as const;

export type BalancesRefusal = InstanceType<(typeof refusals)[number]>;

export const isBalancesRefusal = oneOf<BalancesRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toBalancesError = toBindingError("Paykit.Balances", isBalancesRefusal);

/** Everything `Balances` can answer. */
export type BalancesError = BindingError<BalancesRefusal>;

/** The four reads and writes a customer's balances have. */
export interface BalancesVerb {
  /** Every feature the customer holds a balance for. */
  list(): Effect.Effect<ReadonlyArray<Balance>, BalancesError>;
  /** One feature's balance, or `BalanceNotFound`. */
  get(request: BalanceGetRequest): Effect.Effect<Balance, BalancesError>;
  /** Create a standalone grant and answer the balance it left. */
  create(request: BalanceCreateRequest): Effect.Effect<Balance, BalancesError>;
  /** Set occupancy for a non-consumable feature, and answer its balance. */
  update(request: BalanceUpdateRequest): Effect.Effect<Balance, BalancesError>;
  /** Commit or release a lock, and answer the balance it held. */
  finalize(request: BalanceFinalizeRequest): Effect.Effect<Balance, BalancesError>;
}

/**
 * A customer's balances: the read side of the entitlement plane, one shape for
 * `check`, `track` and this. A balance is what a customer can spend of one
 * feature, with the sources it came from (ADR 0035, ADR 0037).
 *
 * `list` and `get` never record anything. `update` writes occupancy for a
 * non-consumable feature; it never bills and never moves the purchase. `finalize`
 * closes a lock `check({ lock: true })` placed: `commit` bills what ran,
 * `release` returns all of it.
 *
 * ### Reading, then occupying
 * **Example:** One page, one seat count
 * ```typescript
 * const balances = yield* Paykit.Balances(account);
 * const seats = yield* balances.get({ featureId: "seats" });
 * if (seats.remaining !== null && seats.remaining < members.length) {
 *   yield* balances.update({ featureId: "seats", usage: members.length });
 * }
 * ```
 *
 * @binding
 * @product Usage
 * @provides Paykit.Balances
 */
export interface Balances extends Binding.Service<
  Balances,
  "Paykit.Balances",
  (account: string) => Effect.Effect<BalancesVerb>
> {}

export const Balances = Binding.Service<Balances>("Paykit.Balances");
