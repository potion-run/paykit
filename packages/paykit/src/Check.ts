import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BillingReadStore, type BillingReadRow } from "./BillingReadStore.ts";
import { Entitlements, type EntitlementsState } from "./Subscription/Entitlements.view.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import {
  Standing,
  SubscriptionStatus,
  chargeOf,
  creditRateOf,
  spendHeadroomOf,
} from "./Subscription/Subscription.state.ts";

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
          readonly overage: string;
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
  // A credit-priced feature is priced before it is compared: the pool must
  // cover `amount × rate`, not `amount`. Everything else is a count.
  const needed =
    feature.creditRates === undefined
      ? amount
      : amount * creditRateOf(feature.creditRates, input.dimension);
  // A cap is the ceiling, not the standing: at it the account is out of what it
  // bought, which is why `allowed` can be false while `standing` stays `good`.
  const headroom = spendHeadroomOf({
    remaining: feature.remaining,
    cap: feature.cap,
    carried: feature.carried,
  });
  // Postpaid usage is judged in money too: only the part beyond `included` is
  // billable, and a money ceiling refuses the same request a quantity cap would.
  // Open holds are promised units, so the ceiling judges this event and them
  // as one run past `used`; counting each from the same base would give the
  // included room away twice.
  const promised = chargeOf(
    feature.unitPrice,
    feature.included ?? null,
    feature.used ?? 0,
    amount + (feature.reserved ?? 0),
  );
  const moneyAllowed =
    feature.moneyCap === undefined || (feature.billed ?? 0) + promised <= feature.moneyCap;
  // A `null` remaining is an allowance that never runs out: it always has room,
  // and the answer reports the absence of a count rather than a number.
  const allowed =
    state.standing !== "blocked" &&
    (feature.overage !== "block" || feature.remaining === null || needed <= feature.remaining) &&
    (headroom === null || needed <= headroom) &&
    moneyAllowed;
  return {
    allowed,
    remaining: feature.remaining,
    resetsAt: feature.resetsAt,
    standing: state.standing,
  };
};

/**
 * The entitlement plane: one local read, no provider round trip. `check` never
 * records usage; call `Track` in the same transaction that does the work.
 */
export const CheckInProcess = Effect.fn("Paykit.Check.inProcess")(function* () {
  const entitlements = yield* Entitlements;
  return Effect.fn("Paykit.Check.ask")(function* (input: CheckInput) {
    const view = yield* entitlements.query(Subscription.ref(input.account));
    return evaluateCheck(Option.getOrNull(view), input);
  });
});

/** The edge path: one row from `billing_rm_*`, no event fold. */
export const CheckReadModel = Effect.fn("Paykit.Check.readModel")(function* () {
  const store = yield* BillingReadStore;
  return Effect.fn("Paykit.Check.askReadModel")(function* (input: CheckInput) {
    const row = yield* store.get(input.account);
    return evaluateCheck(row === null ? null : rowToState(row), input);
  });
});

/** The cross-service path: delegate to the configured transport. */
export const CheckHttp = Effect.fn("Paykit.Check.http")(function* () {
  const transport = yield* CheckTransport;
  return Effect.fn("Paykit.Check.askHttp")(function* (input: CheckInput) {
    return yield* transport.check(input);
  });
});

/** The default read path: in-process, same host as the model. */
export const Check = CheckInProcess;

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
