import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Overage, Pricing } from "./Allowance.ts";
import { Balance, balanceOfFeature, emptyBalance } from "./Balance.ts";
import type { BillingReadRow } from "./BillingReadStore.ts";
import type { RateCard } from "./Feature.ts";
import { capacityOf } from "./Subscription/Allowance.verdict.ts";
import type { EntitlementsState } from "./Subscription/Entitlements.view.ts";
import { Standing, SubscriptionStatus } from "./Subscription/Subscription.state.ts";

/** What a caller asks before doing work. */
export const CheckInput = Schema.Struct({
  account: Schema.String,
  /** The feature the work needs. */
  featureId: Schema.String,
  /** How much the work will consume. Defaults to 1. */
  requiredBalance: Schema.optionalKey(Schema.Int),
  /** Which rate prices it, for a credit-priced feature. */
  dimension: Schema.optionalKey(Schema.String),
  /** The event's properties, which a rate card's rules and multipliers match. */
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Reserve `requiredBalance` when the answer is allowed. */
  lock: Schema.optionalKey(Schema.Boolean),
  /** The retry key, which is also the hold id when `lock` is set. */
  idempotencyKey: Schema.optionalKey(Schema.String),
});

export type CheckInput = typeof CheckInput.Type;

/** What every `Check` implementation answers: the verdict and the balance it read. */
export const CheckResult = Schema.Struct({
  allowed: Schema.Boolean,
  /** What the customer can spend of the feature, with its sources. */
  balance: Balance,
  standing: Standing,
  /** The hold this check placed, when it was asked to lock. */
  lockId: Schema.optionalKey(Schema.String),
});

export type CheckResult = typeof CheckResult.Type;

/** A cross-service check could not be completed. */
export class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  message: Schema.String,
}) {}

/** The transport a cross-service `Check` reads through. */
export class CheckTransport extends Context.Service<
  CheckTransport,
  {
    readonly check: (input: CheckInput) => Effect.Effect<CheckResult, CheckFailed>;
  }
>()("paykit/CheckTransport") {}

/** Every read path uses this one judgement. */
export const evaluateCheck = (
  state: {
    readonly standing: Standing;
    readonly features: Readonly<
      Record<
        string,
        {
          readonly overage: Overage;
          readonly remaining: number | null;
          readonly resetsAt: DateTime.Utc | null;
          /** Present on a credit-priced feature, whose `remaining` is the pool. */
          readonly creditRates?: RateCard;
          /** Units this period may bill past `included`, when the tier caps it. */
          readonly cap?: number;
          /** How much of `remaining` a rollover added, which a cap does not. */
          readonly carried?: number;
          /** How a billed unit is priced, when the allowance is postpaid. */
          readonly pricing?: Pricing;
          /** The money ceiling for this feature this period, in minor units. */
          readonly moneyCap?: number;
          /** The customer's own money ceiling for this feature. */
          readonly spendLimit?: number;
          /** Money already billed for this feature this period. */
          readonly billed?: number;
          /** Units held by open holds, whose charge is promised too. */
          readonly reserved?: number;
          /** The period's units so far, which decide where billing starts. */
          readonly used?: number;
          /** What the tier included, which bounds the billable part. */
          readonly included?: number | "unlimited" | null;
          /** The quantity a non-consumable feature holds. */
          readonly quantity?: number;
        }
      >
    >;
  } | null,
  input: CheckInput,
): CheckResult => {
  if (state === null) {
    return {
      allowed: false,
      balance: emptyBalance(input.account, input.featureId),
      standing: "blocked",
    };
  }

  const feature = state.features[input.featureId];

  if (feature === undefined) {
    return {
      allowed: false,
      balance: emptyBalance(input.account, input.featureId),
      standing: state.standing,
    };
  }

  // SAFETY: a full `EntitlementsState` carries these fields; a hand-built state
  // carries only the feature facts, and every reader here treats them as absent.
  const plan = state as {
    readonly tier?: string;
    readonly credits?: number;
    readonly prepaidCredits?: number;
  };

  const balance = balanceOfFeature(input.account, input.featureId, feature, plan);
  const requiredBalance = input.requiredBalance ?? 1;

  // One judgement, the same one `decide` runs: the `allowed` a row carries and
  // the answer `check()` gives cannot disagree because there is one rule.
  const verdict = capacityOf({
    standing: state.standing,
    feature: {
      overage: feature.overage,
      included: feature.included ?? null,
      ...(feature.cap === undefined ? {} : { cap: feature.cap }),
      carried: feature.carried ?? 0,
      ...(feature.moneyCap === undefined ? {} : { moneyCap: feature.moneyCap }),
      ...(feature.spendLimit === undefined ? {} : { spendLimit: feature.spendLimit }),
      ...(feature.pricing === undefined ? {} : { pricing: feature.pricing }),
      billed: feature.billed ?? 0,
      used: feature.used ?? 0,
      reserved: feature.reserved ?? 0,
      remaining: feature.remaining,
      ...(feature.creditRates === undefined ? {} : { creditRates: feature.creditRates }),
      ...(feature.quantity === undefined ? {} : { quantity: feature.quantity }),
    },
    ask: {
      amount: requiredBalance,
      ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
      ...(input.properties === undefined ? {} : { properties: input.properties }),
    },
  });

  return {
    allowed: verdict._tag === "Allowed",
    balance,
    standing: state.standing,
  };
};

/** The read model's row as the state `evaluateCheck` reads. */
export const rowToState = (row: BillingReadRow): EntitlementsState => ({
  account: row.account,
  tier: row.tier,
  status: row.status,
  standing: row.standing,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  credits: row.credits,
  dunningAttempts: row.dunningAttempts,
  ...(row.currency === undefined ? {} : { currency: row.currency }),
  prepaidCredits: row.prepaidCredits,
  features: row.features,
});

/** Kept for callers that already use the schema in their own codecs. */
export const CheckStatus = SubscriptionStatus;
