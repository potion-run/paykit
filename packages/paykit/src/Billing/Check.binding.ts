import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { type CheckResult, CheckFailed } from "../Check.ts";
import { HoldExceeded } from "../Subscription/Hold.command.ts";
import { SpendLimitExceeded } from "../Subscription/SpendLimitExceeded.rejection.ts";
import {
  FeatureNotMetered,
  MoneyCapExceeded,
  SpendCapExceeded,
  StandingBlocksUsage,
} from "../Subscription/TrackUsage.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/**
 * What an account asks before doing work. The bound account is not here;
 * `Check(account)` fixed it.
 */
export interface CheckRequest {
  /** The feature the work needs. */
  readonly featureId: string;
  /** How much the work will consume. Defaults to 1. */
  readonly requiredBalance?: number;
  /** Which rate prices it, for a credit-priced feature. */
  readonly dimension?: string;
  /** The event's properties, which a rate card's rules and multipliers match. */
  readonly properties?: Readonly<Record<string, string>>;
  /**
   * Reserve `requiredBalance` when the answer is allowed, so a second caller
   * cannot spend the units between this check and the work. The result carries
   * the `lockId`; finalize it with `Paykit.Balances(account).finalize`.
   */
  readonly lock?: boolean;
  /**
   * The retry key, which is also the hold id when `lock` is set. Required with
   * a lock: two callers must not reserve under one id.
   */
  readonly idempotencyKey?: string;
}

/** A `check` asked to place a lock without an id for it. */
export class CheckLockKeyMissing extends Schema.TaggedError<CheckLockKeyMissing>()(
  "CheckLockKeyMissing",
  {
    featureId: Schema.String,
  },
) {}

/**
 * Everything `Check` can answer. A plain check refuses nothing but a guard; a
 * check with `lock` can also answer a hold's refusals, because it places one.
 */
const refusals = [
  CheckFailed,
  CheckLockKeyMissing,
  HoldExceeded,
  StandingBlocksUsage,
  FeatureNotMetered,
  SpendCapExceeded,
  MoneyCapExceeded,
  SpendLimitExceeded,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal this binding can answer, as the union the layer and the caller share. */
export type CheckRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this command refusing the request. */
export const isCheckRefusal = oneOf<CheckRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toCheckError = toBindingError("Paykit.Check", isCheckRefusal);

/** Everything this binding can answer. */
export type CheckError = BindingError<CheckRefusal>;

/** The verb of a bound `Check`. */
export type CheckVerb = (request: CheckRequest) => Effect.Effect<CheckResult, CheckError>;

/**
 * The entitlement plane: one local read, no provider round trip, and the
 * balance the customer has of one feature. `Check` never records usage —
 * `TrackUsage` is the write, and it judges the allowance in the transaction
 * that records it. Asking before acting is how a caller shows a price, not how
 * it protects a quota: that protection is `TrackUsage` refusing, or a lock.
 *
 * ### Asking before doing work
 * **Example:** Meter a feature whose allowance blocks
 * ```typescript
 * const check = yield* Paykit.Check(account);
 * const answer = yield* check({ featureId: "messages", requiredBalance: 1 });
 * if (!answer.allowed) return showUpgrade(answer.standing, answer.balance.nextResetAt);
 * ```
 *
 * ### Reserving what the work will cost
 * `{ lock: true, idempotencyKey }` places a hold when the answer is allowed, so
 * a second caller cannot spend the units. Finalize it with
 * `Paykit.Balances(account).finalize`.
 *
 * @binding
 * @product Usage
 * @provides Paykit.Check
 */
export interface Check extends Binding.Service<
  Check,
  "Paykit.Check",
  (account: string) => Effect.Effect<CheckVerb>
> {}

export const Check = Binding.Service<Check>("Paykit.Check");
