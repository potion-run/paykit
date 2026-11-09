import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { AllowanceKind, Included, Overage } from "./Allowance.ts";
import type { RateCard } from "./Feature.ts";
import type { EntitlementsState } from "./Subscription/Entitlements.view.ts";

/** Where one part of a balance came from. */
export const BalanceSourceKind = Schema.Literals(["plan", "addon", "one_off", "rollover", "grant"]);

export type BalanceSourceKind = typeof BalanceSourceKind.Type;

/**
 * One source of a feature balance. A plan item is a source with the plan's
 * lifetime, a one-off purchase is a source that never expires with it, and a
 * rollover is its own source with its own boundary (ADR 0037).
 *
 * `granted` and `remaining` are `null` when the source has no count: an
 * unlimited plan item, or a flag.
 */
export const BalanceSource = Schema.Struct({
  /** Stable within a balance: the plan and feature, or the purchase kind. */
  id: Schema.String,
  kind: BalanceSourceKind,
  granted: Schema.NullOr(Schema.Int),
  remaining: Schema.NullOr(Schema.Int),
  usage: Schema.Int,
  /** The reset interval the source runs on: `never` for a lifetime grant. */
  interval: Schema.String,
  /** The plan that granted it, for a plan or add-on source. */
  planId: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  resetAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export type BalanceSource = typeof BalanceSource.Type;

/**
 * The customer's money ceiling on one feature, and the headroom left under it.
 * `remaining` is money, not units: it is the `Balance.remaining` for a feature
 * the customer capped.
 */
export const SpendLimitView = Schema.Struct({
  /** The ceiling for this period, in minor units. */
  amount: Schema.Int,
  /** What may still bill: `max(0, amount - billed)`. */
  remaining: Schema.Int,
});

export type SpendLimitView = typeof SpendLimitView.Type;

/**
 * What a customer can spend of one feature, and where it came from. This is the
 * object `check()` and `track()` answer with, so a caller never has to read the
 * entitlement view and rebuild it.
 *
 * For a non-consumable feature, `purchased` is what was bought, `occupied` is
 * what is in use, and `remaining` is the difference — which may be negative
 * (ADR 0036).
 */
export const Balance = Schema.Struct({
  customerId: Schema.String,
  featureId: Schema.String,
  /** The plan's grant, the shared pool for a credit feature, or the purchase for a seat. */
  granted: Schema.NullOr(Schema.Int),
  /** Spendable now. `null` means there is no count: an unlimited item, or a flag. */
  remaining: Schema.NullOr(Schema.Int),
  /** Units (or credits) consumed this period. For a seat, the occupied count. */
  usage: Schema.Int,
  unlimited: Schema.Boolean,
  overageAllowed: Schema.Boolean,
  nextResetAt: Schema.NullOr(Schema.DateTimeUtc),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  breakdown: Schema.Array(BalanceSource),
  /** The quantity bought, for a non-consumable feature. */
  purchased: Schema.optionalKey(Schema.Int),
  /** The quantity in use, for a non-consumable feature. */
  occupied: Schema.optionalKey(Schema.Int),
  /** The customer's money ceiling for this feature, when it states one. */
  spendLimit: Schema.optionalKey(SpendLimitView),
});

export type Balance = typeof Balance.Type;

/** A list of balances, with the cursor a page reads next. */
export const BalancePage = Schema.Struct({
  balances: Schema.Array(Balance),
  cursor: Schema.NullOr(Schema.String),
});

export type BalancePage = typeof BalancePage.Type;

/**
 * The facts a balance needs from a feature row. A full `FeatureEntitlement` is
 * one, and so is the smaller row a `check` test builds: the derivation reads
 * only what the balance reports, and defaults the rest the way the view does.
 */
export interface BalanceFeature {
  readonly overage: Overage;
  readonly remaining: number | null;
  readonly resetsAt: DateTime.Utc | null;
  readonly resets?: string;
  readonly kind?: AllowanceKind;
  readonly included?: Included | null;
  readonly carried?: number;
  readonly used?: number;
  /** Money this feature billed this period, which a spend ceiling bounds. */
  readonly billed?: number;
  /** The customer's money ceiling for this feature this period, in minor units. */
  readonly spendLimit?: number;
  readonly quantity?: number;
  readonly creditRates?: RateCard;
  /** The standalone grants the feature holds, as the read model carries them. */
  readonly grants?: ReadonlyArray<{
    readonly id: string;
    readonly granted: number;
    readonly remaining: number;
    readonly expiresAt?: DateTime.Utc;
  }>;
}

/** The plan item's own source, when it has a feature row. */
const planSource = (
  featureId: string,
  feature: BalanceFeature,
  planId: string,
  granted: number | null,
  remaining: number | null,
  usage: number,
): BalanceSource => ({
  id: `${planId}:${featureId}`,
  kind: "plan",
  granted,
  remaining,
  usage,
  interval: feature.resets ?? "never",
  ...(planId.length === 0 ? {} : { planId }),
  ...(feature.resetsAt === null ? {} : { resetAt: feature.resetsAt }),
});

/** What a feature's plan identity and pool say about its sources. */
export interface BalancePlan {
  readonly tier?: string;
  readonly credits?: number;
  readonly prepaidCredits?: number;
}

/**
 * A feature's balance, from one feature row. One derivation, used by `check`,
 * `track` and `balances`, so those three cannot disagree about what a feature
 * has left.
 */
export const balanceOfFeature = (
  customerId: string,
  featureId: string,
  feature: BalanceFeature,
  plan: BalancePlan = {},
): Balance => {
  const tier = plan.tier ?? "";
  const credits = plan.credits ?? 0;
  const prepaid = Math.min(plan.prepaidCredits ?? 0, credits);

  const spendLimit =
    feature.spendLimit === undefined
      ? undefined
      : {
          amount: feature.spendLimit,
          remaining: Math.max(0, feature.spendLimit - (feature.billed ?? 0)),
        };

  // A credit-priced feature has no items of its own: its balance is the shared
  // pool, and the pool has two sources — the plan's grant and a lifetime pack.
  if (feature.creditRates !== undefined) {
    const remaining = feature.remaining;
    const planGranted = Math.max(0, credits - prepaid);
    const planRemaining = Math.max(0, (remaining ?? 0) - prepaid);

    const sources: Array<BalanceSource> = [
      {
        id: `credits:${tier}`,
        kind: "plan",
        granted: planGranted,
        remaining: planRemaining,
        usage: planGranted - planRemaining,
        interval: "period",
        ...(tier.length === 0 ? {} : { planId: tier }),
      },
      ...(prepaid === 0
        ? []
        : [
            {
              id: "credits:one_off",
              kind: "one_off" as const,
              granted: prepaid,
              remaining: Math.min(prepaid, Math.max(0, remaining ?? 0)),
              usage: prepaid - Math.min(prepaid, Math.max(0, remaining ?? 0)),
              interval: "never",
            },
          ]),
    ];

    return {
      customerId,
      featureId,
      granted: credits,
      remaining,
      usage: feature.used ?? 0,
      unlimited: false,
      overageAllowed: feature.overage !== "block",
      nextResetAt: feature.resetsAt,
      breakdown: sources,
      ...(spendLimit === undefined ? {} : { spendLimit }),
    };
  }

  // A flag is granted, not counted: no grant and no remaining, only the fact
  // that the account has it.
  if (feature.kind === "flag") {
    return {
      customerId,
      featureId,
      granted: null,
      remaining: null,
      usage: 0,
      unlimited: true,
      overageAllowed: false,
      nextResetAt: null,
      breakdown: [],
      ...(spendLimit === undefined ? {} : { spendLimit }),
    };
  }

  // A seat is bought and occupied. Its grant is the purchase, its usage is the
  // occupancy, and its remaining may be negative (ADR 0036).
  if (feature.kind === "non_consumable") {
    const purchased = feature.quantity ?? 0;
    const occupied = feature.used ?? 0;

    return {
      customerId,
      featureId,
      granted: purchased,
      remaining: feature.remaining,
      usage: occupied,
      unlimited: false,
      overageAllowed: feature.overage !== "block",
      nextResetAt: null,
      breakdown: [planSource(featureId, feature, tier, purchased, feature.remaining, occupied)],
      purchased,
      occupied,
      ...(spendLimit === undefined ? {} : { spendLimit }),
    };
  }

  const unlimited = feature.included === "unlimited";
  const grants = feature.grants ?? [];
  const grantsTotal = grants.reduce((sum, grant) => sum + grant.remaining, 0);
  const planIncluded = typeof feature.included === "number" ? feature.included : 0;
  // The plan and rollover are the total less the grants; a grant is the last
  // source a spend reaches. A grant-only feature has no plan part at all.
  const planPart = Math.max(0, (feature.remaining ?? 0) - grantsTotal);
  const planRemaining = Math.min(planPart, planIncluded);
  const rollover = Math.max(0, planPart - planRemaining);

  const sources: Array<BalanceSource> = [
    ...(planIncluded === 0
      ? []
      : [
          planSource(
            featureId,
            feature,
            tier,
            planIncluded,
            planRemaining,
            planIncluded - planRemaining,
          ),
        ]),
    ...(rollover === 0
      ? []
      : [
          {
            id: `rollover:${featureId}`,
            kind: "rollover" as const,
            granted: feature.carried ?? rollover,
            remaining: rollover,
            usage: Math.max(0, (feature.carried ?? rollover) - rollover),
            interval: "never",
          },
        ]),
    ...grants.map((grant) => ({
      id: grant.id,
      kind: "grant" as const,
      granted: grant.granted,
      remaining: grant.remaining,
      usage: grant.granted - grant.remaining,
      interval: "never",
      ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
    })),
  ];

  const granted =
    typeof feature.included === "number"
      ? feature.included + (feature.carried ?? 0) + grantsTotal
      : null;

  return {
    customerId,
    featureId,
    granted,
    remaining: feature.remaining,
    usage: feature.used ?? 0,
    unlimited,
    overageAllowed: feature.overage !== "block",
    nextResetAt: feature.resetsAt,
    breakdown: sources,
    ...(spendLimit === undefined ? {} : { spendLimit }),
  };
};

/** A feature's balance, from the entitlement view. */
export const balanceOf = (state: EntitlementsState, featureId: string): Balance | null => {
  const feature = state.features[featureId];

  if (feature === undefined) return null;

  return balanceOfFeature(state.account, featureId, feature, {
    tier: state.tier,
    credits: state.credits,
    prepaidCredits: state.prepaidCredits,
  });
};

/** Every feature the account holds a balance for, in the view's order. */
export const balancesOf = (state: EntitlementsState): ReadonlyArray<Balance> =>
  Object.keys(state.features).flatMap((featureId) => {
    const balance = balanceOf(state, featureId);

    return balance === null ? [] : [balance];
  });

/**
 * The balance a blocked or absent account reports. A missing row is not an
 * error for `check`: it is a feature the account has nothing of.
 */
export const emptyBalance = (customerId: string, featureId: string): Balance => ({
  customerId,
  featureId,
  granted: 0,
  remaining: 0,
  usage: 0,
  unlimited: false,
  overageAllowed: false,
  nextResetAt: null,
  breakdown: [],
});
