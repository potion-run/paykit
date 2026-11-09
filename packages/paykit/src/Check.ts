import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Overage, Pricing } from "./Allowance.ts";
import { Balance, balanceOfEntity, balanceOfFeature, emptyBalance } from "./Balance.ts";
import type { BillingReadRow } from "./BillingReadStore.ts";
import { entityScope, EntityId } from "./Customer.ts";
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
  /**
   * The entity scope to ask for; absent means the customer. An archived entity
   * answers `allowed: false` with an empty balance, and an unknown id is a
   * refusal at the binding, not a scope with nothing in it (ADR 0040 §4).
   */
  entityId: Schema.optionalKey(Schema.String),
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
    /** Present on a full read model, which an entity scope needs. */
    readonly account?: string;
    readonly tier?: string;
    readonly credits?: number;
    readonly prepaidCredits?: number;
    readonly entities?: EntitlementsState["entities"];
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

  // An entity reads its own rows plus the one shared pool; its `remaining` is
  // what it may spend, which is the number the judgement must see.
  if (input.entityId !== undefined) {
    const entity = state.entities?.[input.entityId];
    const scope = entityScope(EntityId.make(input.entityId));

    if (entity === undefined || entity.status === "archived") {
      return {
        allowed: false,
        balance: emptyBalance(input.account, input.featureId, scope),
        standing: state.standing,
      };
    }

    // SAFETY: the entity branch only reads the scope maps, and a state without
    // them has no entity id to reach this branch with.
    const balance = balanceOfEntity(
      { ...state, account: state.account ?? input.account } as EntitlementsState,
      input.entityId,
      input.featureId,
    );

    if (balance === null) {
      return {
        allowed: false,
        balance: emptyBalance(input.account, input.featureId, scope),
        standing: state.standing,
      };
    }

    const feature = entity.features[input.featureId] ?? state.features[input.featureId];

    return {
      allowed: verdictOf(state.standing, feature, balance.remaining, input),
      balance,
      standing: state.standing,
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

/** The one judgement, from a feature row and the count the scope may spend. */
const verdictOf = (
  standing: Standing,
  feature:
    | {
        readonly overage: Overage;
        readonly remaining: number | null;
        readonly resetsAt: DateTime.Utc | null;
        readonly creditRates?: RateCard;
        readonly cap?: number;
        readonly carried?: number;
        readonly pricing?: Pricing;
        readonly moneyCap?: number;
        readonly spendLimit?: number;
        readonly billed?: number;
        readonly reserved?: number;
        readonly used?: number;
        readonly included?: number | "unlimited" | null;
        readonly quantity?: number;
      }
    | undefined,
  remaining: number | null,
  input: CheckInput,
): boolean => {
  if (feature === undefined) return remaining !== null && (input.requiredBalance ?? 1) <= remaining;

  const verdict = capacityOf({
    standing,
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
      remaining,
      ...(feature.creditRates === undefined ? {} : { creditRates: feature.creditRates }),
      ...(feature.quantity === undefined ? {} : { quantity: feature.quantity }),
    },
    ask: {
      amount: input.requiredBalance ?? 1,
      ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
      ...(input.properties === undefined ? {} : { properties: input.properties }),
    },
  });

  return verdict._tag === "Allowed";
};

/**
 * The read model's row as the state `evaluateCheck` reads. With an `entityId`
 * the row becomes that scope: its own features under `entities`, and the
 * customer's pooled rows kept so the shared source is still one row
 * (ADR 0040 §4).
 */
export const rowToState = (row: BillingReadRow, entityId?: string): EntitlementsState => ({
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
  features:
    entityId === undefined
      ? row.features
      : Object.fromEntries(
          Object.entries(row.features).filter(([, feature]) => feature.pooled === true),
        ),
  ...(row.entities === undefined ? {} : { entities: row.entities }),
});

/** Kept for callers that already use the schema in their own codecs. */
export const CheckStatus = SubscriptionStatus;
