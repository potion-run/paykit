import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Overage } from "./Allowance.ts";
import type { BillingReadRow } from "./BillingReadStore.ts";
import { capacityOf } from "./Subscription/Allowance.verdict.ts";
import type { EntitlementsState } from "./Subscription/Entitlements.view.ts";
import { Standing, SubscriptionStatus } from "./Subscription/Subscription.state.ts";

/** What a caller asks before doing work. */
export const CheckInput = Schema.Struct({
  account: Schema.String,
  feature: Schema.String,
  /** How much will be consumed. Defaults to 1. */
  amount: Schema.optionalKey(Schema.Int),
  /** Which rate prices it, for a credit-priced feature. */
  dimension: Schema.optionalKey(Schema.String),
});
export type CheckInput = typeof CheckInput.Type;

/** What every `Check` implementation answers. */
export const CheckResult = Schema.Struct({
  allowed: Schema.Boolean,
  /** Spendable now. `null` means there is no count: an unlimited allowance or a flag. */
  remaining: Schema.NullOr(Schema.Int),
  resetsAt: Schema.NullOr(Schema.DateTimeUtc),
  standing: Standing,
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

const blocked: CheckResult = {
  allowed: false,
  remaining: 0,
  resetsAt: null,
  standing: "blocked",
};

/** Judge one feature from a read model. Every read path uses this. */
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
          readonly creditRates?: Readonly<Record<string, number>>;
          /** Units this period may bill past `included`, when the tier caps it. */
          readonly cap?: number;
          /** How much of `remaining` a rollover added, which a cap does not. */
          readonly carried?: number;
          /** What one billed unit costs, when the allowance is postpaid. */
          readonly unitPrice?: { readonly amount: number; readonly currency: string };
          /** The money ceiling for this feature this period, in minor units. */
          readonly moneyCap?: number;
          /** Money already billed for this feature this period. */
          readonly billed?: number;
          /** Units held by open holds, whose charge is promised too. */
          readonly reserved?: number;
          /** The period's units so far, which decide where billing starts. */
          readonly used?: number;
          /** What the tier included, which bounds the billable part. */
          readonly included?: number | "unlimited" | null;
        }
      >
    >;
  } | null,
  input: CheckInput,
): CheckResult => {
  if (state === null) return blocked;
  const feature = state.features[input.feature];
  if (feature === undefined) {
    return { allowed: false, remaining: 0, resetsAt: null, standing: state.standing };
  }
  const amount = input.amount ?? 1;
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
      ...(feature.unitPrice === undefined ? {} : { unitPrice: feature.unitPrice }),
      billed: feature.billed ?? 0,
      used: feature.used ?? 0,
      reserved: feature.reserved ?? 0,
      remaining: feature.remaining,
      ...(feature.creditRates === undefined ? {} : { creditRates: feature.creditRates }),
    },
    ask: {
      amount,
      ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
    },
  });
  return {
    allowed: verdict._tag === "Allowed",
    remaining: feature.remaining,
    resetsAt: feature.resetsAt,
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
  features: row.features,
});

/** Kept for callers that already use the schema in their own codecs. */
export const CheckStatus = SubscriptionStatus;
