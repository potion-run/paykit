import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BillingReadStore, type BillingReadRow } from "./BillingReadStore.ts";
import { Entitlements, type EntitlementsState } from "./Subscription/Entitlements.view.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import { Standing, SubscriptionStatus } from "./Subscription/Subscription.state.ts";

/** What a caller asks before doing work. */
export const CheckInput = Schema.Struct({
  account: Schema.String,
  feature: Schema.String,
  /** How much will be consumed. Defaults to 1. */
  amount: Schema.optionalKey(Schema.Int),
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
  // A `null` remaining is an allowance that never runs out: it always has room,
  // and the answer reports the absence of a count rather than a number.
  const allowed =
    state.standing !== "blocked" &&
    (feature.overage !== "block" || feature.remaining === null || amount <= feature.remaining);
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

const rowToState = (row: BillingReadRow): EntitlementsState => ({
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
