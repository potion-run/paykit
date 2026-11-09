import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Overage, Resets } from "../../src/Allowance.ts";
import {
  balanceOf,
  balanceOfFeature,
  balancesOf,
  emptyBalance,
  type Balance,
  type BalanceFeature,
} from "../../src/Balance.ts";
import type { EntitlementsState } from "../../src/Subscription/Entitlements.view.ts";
import { assertProperty } from "../support/Property.ts";

/** The customer scope, and the plan facts a feature row is read with. */
const account = "acct_balance_property";
const featureId = "messages";
const tier = "pro";
const plan = { tier, credits: 0, prepaidCredits: 0 };

/** Fixed instants, so a generated feature never depends on the wall clock. */
const resetAt = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const expiresAt = DateTime.makeUnsafe("2030-03-01T00:00:00Z");

const Count = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 120 })));

const PlanRow = Schema.Struct({
  included: Count,
  resets: Schema.optionalKey(Resets),
});

type PlanRow = typeof PlanRow.Type;

const Grant = Schema.Struct({
  granted: Count,
  remaining: Count,
  expires: Schema.Boolean,
});

type Grant = typeof Grant.Type;

const Grants = Schema.Array(Grant).pipe(Schema.check(Schema.isMaxLength(3)));

const ManyGrants = Schema.Array(Grant).pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3)),
);

/**
 * The plan identities a feature's `planSources` carry. They are derived from
 * the row's position rather than generated: two active plans cannot share an
 * id, and a collision would make "one source per plan" unreadable.
 */
const planRowsOf = (rows: ReadonlyArray<PlanRow>) =>
  rows.map((row, index) => ({
    planId: `plan-${index}`,
    included: row.included,
    ...(row.resets === undefined ? {} : { resets: row.resets }),
  }));

const grantsOf = (grants: ReadonlyArray<Grant>) =>
  grants.map((grant, index) => ({
    id: `grant-${index}`,
    granted: grant.granted,
    remaining: Math.min(grant.granted, grant.remaining),
    ...(grant.expires ? { expiresAt } : {}),
  }));

const sumOf = (values: Iterable<number>): number => {
  let total = 0;

  for (const value of values) total += value;

  return total;
};

/**
 * Every source has one id, lives in the customer scope, and reports the same
 * arithmetic it was built from.
 */
const sourcesTieOut = (balance: Balance): boolean => {
  const ids = new Set(balance.breakdown.map((source) => source.id));

  if (balance.scope.kind !== "customer") return false;

  if (balance.breakdown.some((source) => source.scope.kind !== "customer")) return false;

  if (ids.size !== balance.breakdown.length) return false;

  return balance.breakdown.every(
    (source) =>
      source.granted === null ||
      source.remaining === null ||
      source.usage === source.granted - source.remaining,
  );
};

const spendLimitHolds = (balance: Balance, feature: BalanceFeature): boolean => {
  if (feature.spendLimit === undefined) return balance.spendLimit === undefined;

  return (
    balance.spendLimit?.amount === feature.spendLimit &&
    balance.spendLimit.remaining === Math.max(0, feature.spendLimit - (feature.billed ?? 0))
  );
};

const sourceKinds = (balance: Balance): string =>
  balance.breakdown.map((source) => source.kind).join(",");

const grantedOf = (balance: Balance): ReadonlyArray<number | null> =>
  balance.breakdown.map((source) => source.granted);

const remainingOf = (balance: Balance): ReadonlyArray<number | null> =>
  balance.breakdown.map((source) => source.remaining);

// ---------------------------------------------------------------------------
// Counted features
// ---------------------------------------------------------------------------

const CountedPlanCase = Schema.Struct({
  rows: Schema.Array(PlanRow).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3))),
  rollover: Count,
  planLeft: Count,
  carriedExtra: Count,
  grants: Grants,
  overage: Overage,
  hasResetAt: Schema.Boolean,
  spendLimit: Schema.optionalKey(Count),
  billed: Count,
});

type CountedPlanCase = typeof CountedPlanCase.Type;

const CountedCase = Schema.Struct({
  included: Count,
  rollover: Count,
  planLeft: Count,
  carriedExtra: Count,
  grants: Grants,
  overage: Overage,
  hasResetAt: Schema.Boolean,
  spendLimit: Schema.optionalKey(Count),
  billed: Count,
});

type CountedCase = typeof CountedCase.Type;

/**
 * The arithmetic a counted row shares whatever its plan shape: the plan keeps
 * the first `included` units, a rollover is what remains past them, and a grant
 * is spent only after both.
 */
const countedNumbersOf = (
  included: number,
  c: {
    readonly rollover: number;
    readonly planLeft: number;
    readonly carriedExtra: number;
    readonly grants: ReadonlyArray<Grant>;
  },
) => {
  const planRemaining = c.rollover > 0 ? included : Math.min(c.planLeft, included);
  const carried = c.rollover + c.carriedExtra;
  const grants = grantsOf(c.grants);
  const grantsRemaining = sumOf(grants.map((grant) => grant.remaining));
  const grantsGranted = sumOf(grants.map((grant) => grant.granted));
  const remaining = planRemaining + c.rollover + grantsRemaining;
  // A coherent row: what the period granted, less what it left, is what it used.
  const used = included + carried + grantsGranted - remaining;

  return {
    planRemaining,
    carried,
    grants,
    grantsRemaining,
    grantsGranted,
    remaining,
    used,
  };
};

const countedPlanOf = (c: CountedPlanCase) => {
  const included = sumOf(c.rows.map((row) => row.included));
  const numbers = countedNumbersOf(included, c);

  const feature: BalanceFeature = {
    overage: c.overage,
    included,
    remaining: numbers.remaining,
    carried: numbers.carried,
    used: numbers.used,
    resets: "month",
    resetsAt: c.hasResetAt ? resetAt : null,
    planSources: planRowsOf(c.rows),
    grants: numbers.grants,
    ...(c.spendLimit === undefined ? {} : { spendLimit: c.spendLimit }),
    ...(c.spendLimit === undefined ? {} : { billed: c.billed }),
  };

  return { feature, included, ...numbers };
};

const countedOf = (c: CountedCase) => {
  const numbers = countedNumbersOf(c.included, c);

  const feature: BalanceFeature = {
    overage: c.overage,
    included: c.included,
    remaining: numbers.remaining,
    carried: numbers.carried,
    used: numbers.used,
    resets: "month",
    resetsAt: c.hasResetAt ? resetAt : null,
    grants: numbers.grants,
    ...(c.spendLimit === undefined ? {} : { spendLimit: c.spendLimit }),
    ...(c.spendLimit === undefined ? {} : { billed: c.billed }),
  };

  return { feature, ...numbers };
};

/** The supplied rollover is exactly the part a plan cannot explain. */
const excessOf = (feature: BalanceFeature, grantsRemaining: number, included: number): number =>
  (feature.remaining ?? 0) - grantsRemaining - included;

describe("a counted feature's plan sources", () => {
  it.effect("splits the included count by plan and spends rollover and grants last", () =>
    assertProperty(
      Arbitrary.schema(CountedPlanCase),
      (c) => {
        const { feature, included, planRemaining, carried, grantsRemaining, grantsGranted } =
          countedPlanOf(c);

        const balance = balanceOfFeature(account, featureId, feature, plan);
        const planSources = balance.breakdown.filter((source) => source.kind === "plan");
        const rollovers = balance.breakdown.filter((source) => source.kind === "rollover");
        const grantSources = balance.breakdown.filter((source) => source.kind === "grant");

        if (planSources.length !== c.rows.length) return false;

        if (planSources.some((source, index) => source.granted !== c.rows[index]?.included)) {
          return false;
        }

        if (planSources.some((source, index) => source.planId !== `plan-${index}`)) return false;

        if (planSources.some((source, index) => source.id !== `plan-${index}:${featureId}`)) {
          return false;
        }

        if (
          planSources.some(
            (source, index) => source.interval !== (c.rows[index]?.resets ?? "month"),
          )
        ) {
          return false;
        }

        // The plan sources total the plan's included count; a rollover is the
        // part past it, and a grant adds a source after both.
        if (sumOf(planSources.map((source) => source.granted ?? 0)) !== included) return false;

        if (sumOf(planSources.map((source) => source.remaining ?? 0)) !== planRemaining) {
          return false;
        }

        // With no grant in the row, the plan's remaining is what the balance
        // leaves under `included`; a grant adds a source and no longer moves it.
        if (
          c.grants.length === 0 &&
          sumOf(planSources.map((source) => source.remaining ?? 0)) !==
            Math.min(feature.remaining ?? 0, included)
        ) {
          return false;
        }

        const excess = excessOf(feature, grantsRemaining, included);
        const hasRollover = excess > 0;

        if ((rollovers.length === 1) !== hasRollover) return false;

        if (rollovers.length === 1) {
          const [rollover] = rollovers;

          if (rollover === undefined) return false;

          if (rollover.id !== `rollover:${featureId}`) return false;

          if (rollover.granted !== carried) return false;

          if (rollover.remaining !== excess) return false;

          if (rollover.usage !== Math.max(0, carried - excess)) return false;
        }

        if (grantSources.length !== c.grants.length) return false;

        if (grantSources.some((source, index) => source.id !== `grant-${index}`)) return false;

        if (sumOf(grantSources.map((source) => source.granted ?? 0)) !== grantsGranted) {
          return false;
        }

        if (sumOf(grantSources.map((source) => source.remaining ?? 0)) !== grantsRemaining) {
          return false;
        }

        if (
          grantSources.some((source, index) =>
            c.grants[index]?.expires === true
              ? source.expiresAt !== expiresAt
              : source.expiresAt !== undefined,
          )
        ) {
          return false;
        }

        if (
          sourceKinds(balance) !==
          [
            ...c.rows.map(() => "plan"),
            ...(c.rollover > 0 ? ["rollover"] : []),
            ...c.grants.map(() => "grant"),
          ].join(",")
        ) {
          return false;
        }

        if (balance.unlimited !== false) return false;

        if (balance.overageAllowed !== (c.overage !== "block")) return false;

        if (balance.nextResetAt !== (c.hasResetAt ? resetAt : null)) return false;

        if (!spendLimitHolds(balance, feature)) return false;

        return sourcesTieOut(balance);
      },
      { runs: 120, size: 36 },
    ),
  );

  it.effect("reports one plan source, then a rollover, then every grant", () =>
    assertProperty(
      Arbitrary.schema(CountedCase),
      (c) => {
        const { feature, planRemaining, carried, grantsRemaining, grantsGranted } = countedOf(c);
        const balance = balanceOfFeature(account, featureId, feature, plan);
        const planSources = balance.breakdown.filter((source) => source.kind === "plan");
        const rollovers = balance.breakdown.filter((source) => source.kind === "rollover");
        const grantSources = balance.breakdown.filter((source) => source.kind === "grant");

        if (planSources.length !== (c.included > 0 ? 1 : 0)) return false;

        if (planSources.length === 1) {
          const [source] = planSources;

          if (source === undefined) return false;

          if (source.id !== `${tier}:${featureId}`) return false;

          if (source.planId !== tier) return false;

          if (source.granted !== c.included) return false;

          if (source.remaining !== planRemaining) return false;

          if (source.interval !== "month") return false;
        }

        const excess = excessOf(feature, grantsRemaining, c.included);
        const hasRollover = excess > 0;

        if ((rollovers.length === 1) !== hasRollover) return false;

        if (rollovers.length === 1) {
          const [rollover] = rollovers;

          if (rollover === undefined) return false;

          if (rollover.granted !== carried) return false;

          if (rollover.remaining !== excess) return false;
        }

        if (grantSources.length !== c.grants.length) return false;

        if (grantSources.some((source, index) => source.id !== `grant-${index}`)) return false;

        if (sumOf(grantSources.map((source) => source.granted ?? 0)) !== grantsGranted) {
          return false;
        }

        if (sumOf(grantSources.map((source) => source.remaining ?? 0)) !== grantsRemaining) {
          return false;
        }

        if (
          sourceKinds(balance) !==
          [
            ...(c.included > 0 ? ["plan"] : []),
            ...(c.rollover > 0 ? ["rollover"] : []),
            ...c.grants.map(() => "grant"),
          ].join(",")
        ) {
          return false;
        }

        if (balance.unlimited !== false) return false;

        if (balance.overageAllowed !== (c.overage !== "block")) return false;

        if (balance.nextResetAt !== (c.hasResetAt ? resetAt : null)) return false;

        if (!spendLimitHolds(balance, feature)) return false;

        return sourcesTieOut(balance);
      },
      { runs: 120, size: 36 },
    ),
  );
});

// ---------------------------------------------------------------------------
// A grant-only feature
// ---------------------------------------------------------------------------

const GrantOnlyCase = Schema.Struct({
  grants: ManyGrants,
  overage: Overage,
  spendLimit: Schema.optionalKey(Count),
  billed: Count,
});

type GrantOnlyCase = typeof GrantOnlyCase.Type;

const grantOnlyOf = (c: GrantOnlyCase) => {
  const grants = grantsOf(c.grants);
  const grantsRemaining = sumOf(grants.map((grant) => grant.remaining));
  const grantsGranted = sumOf(grants.map((grant) => grant.granted));

  const feature: BalanceFeature = {
    overage: c.overage,
    included: 0,
    remaining: grantsRemaining,
    carried: 0,
    used: grantsGranted - grantsRemaining,
    resets: "never",
    resetsAt: null,
    grants,
    ...(c.spendLimit === undefined ? {} : { spendLimit: c.spendLimit }),
    ...(c.spendLimit === undefined ? {} : { billed: c.billed }),
  };

  return { feature, grantsRemaining, grantsGranted };
};

describe("a grant-only feature", () => {
  it.effect("has no plan part, so every source is a grant", () =>
    assertProperty(
      Arbitrary.schema(GrantOnlyCase),
      (c) => {
        const { feature, grantsRemaining, grantsGranted } = grantOnlyOf(c);
        const balance = balanceOfFeature(account, featureId, feature, plan);

        if (balance.breakdown.length !== c.grants.length) return false;

        if (balance.breakdown.some((source) => source.kind !== "grant")) return false;

        if (
          balance.breakdown.some(
            (source, index) => source.id !== `grant-${index}` || source.scope.kind !== "customer",
          )
        ) {
          return false;
        }

        if (sumOf(balance.breakdown.map((source) => source.granted ?? 0)) !== grantsGranted) {
          return false;
        }

        if (sumOf(balance.breakdown.map((source) => source.remaining ?? 0)) !== grantsRemaining) {
          return false;
        }

        if (balance.remaining !== grantsRemaining) return false;

        if (balance.unlimited !== false) return false;

        if (balance.nextResetAt !== null) return false;

        if (!spendLimitHolds(balance, feature)) return false;

        return sourcesTieOut(balance);
      },
      { runs: 100, size: 30 },
    ),
  );
});

// ---------------------------------------------------------------------------
// An unlimited counted feature
// ---------------------------------------------------------------------------

const UnlimitedCase = Schema.Struct({
  grants: Grants,
  overage: Overage,
  hasResetAt: Schema.Boolean,
  spendLimit: Schema.optionalKey(Count),
  billed: Count,
});

type UnlimitedCase = typeof UnlimitedCase.Type;

const unlimitedOf = (c: UnlimitedCase): BalanceFeature => ({
  overage: c.overage,
  included: "unlimited",
  remaining: null,
  carried: 0,
  used: 0,
  resets: "month",
  resetsAt: c.hasResetAt ? resetAt : null,
  grants: grantsOf(c.grants),
  ...(c.spendLimit === undefined ? {} : { spendLimit: c.spendLimit }),
  ...(c.spendLimit === undefined ? {} : { billed: c.billed }),
});

describe("an unlimited feature", () => {
  it.effect("carries no plan count but keeps its grants and reset", () =>
    assertProperty(
      Arbitrary.schema(UnlimitedCase),
      (c) => {
        const feature = unlimitedOf(c);
        const balance = balanceOfFeature(account, featureId, feature, plan);
        const planSources = balance.breakdown.filter((source) => source.kind === "plan");
        const grantSources = balance.breakdown.filter((source) => source.kind === "grant");

        if (planSources.length !== 1) return false;

        if (planSources[0]?.granted !== null) return false;

        if (planSources[0]?.remaining !== null) return false;

        if (planSources[0]?.usage !== 0) return false;

        if (grantSources.length !== c.grants.length) return false;

        if (
          sumOf(grantSources.map((source) => source.granted ?? 0)) !==
          sumOf(c.grants.map((grant) => grant.granted))
        ) {
          return false;
        }

        if (balance.granted !== null) return false;

        if (balance.remaining !== null) return false;

        if (balance.usage !== 0) return false;

        if (balance.unlimited !== true) return false;

        if (balance.overageAllowed !== (c.overage !== "block")) return false;

        if (balance.nextResetAt !== (c.hasResetAt ? resetAt : null)) return false;

        if (!spendLimitHolds(balance, feature)) return false;

        return sourcesTieOut(balance);
      },
      { runs: 100, size: 30 },
    ),
  );
});

// ---------------------------------------------------------------------------
// A credit-priced feature
// ---------------------------------------------------------------------------

const CreditCase = Schema.Struct({
  tier: Schema.Literals(["free", "pro", "scale"]),
  credits: Count,
  prepaid: Count,
  remaining: Schema.NullOr(Count),
  used: Count,
  overage: Overage,
  hasResetAt: Schema.Boolean,
  spendLimit: Schema.optionalKey(Count),
  billed: Count,
});

type CreditCase = typeof CreditCase.Type;

const creditOf = (c: CreditCase): BalanceFeature => ({
  overage: c.overage,
  included: null,
  remaining: c.remaining,
  used: c.used,
  resets: "month",
  resetsAt: c.hasResetAt ? resetAt : null,
  creditRates: { default: 2 },
  ...(c.spendLimit === undefined ? {} : { spendLimit: c.spendLimit }),
  ...(c.spendLimit === undefined ? {} : { billed: c.billed }),
});

describe("a credit-priced feature", () => {
  it.effect("reports the pool and a separately clamped lifetime source", () =>
    assertProperty(
      Arbitrary.schema(CreditCase),
      (c) => {
        const feature = creditOf(c);

        const balance = balanceOfFeature(account, featureId, feature, {
          tier: c.tier,
          credits: c.credits,
          prepaidCredits: c.prepaid,
        });

        const prepaid = Math.min(c.prepaid, c.credits);
        const remaining = c.remaining ?? 0;
        const planGranted = Math.max(0, c.credits - prepaid);
        const planRemaining = Math.max(0, remaining - prepaid);
        const [planSource, prepaidSource] = balance.breakdown;

        if (planSource === undefined) return false;

        if (planSource.id !== `credits:${c.tier}`) return false;

        if (planSource.planId !== c.tier) return false;

        if (planSource.kind !== "plan") return false;

        if (planSource.granted !== planGranted) return false;

        if (planSource.remaining !== planRemaining) return false;

        if (planSource.usage !== planGranted - planRemaining) return false;

        if (planSource.interval !== "period") return false;

        if (prepaid === 0) {
          if (balance.breakdown.length !== 1) return false;

          if (prepaidSource !== undefined) return false;
        } else {
          if (balance.breakdown.length !== 2) return false;

          if (prepaidSource === undefined) return false;

          if (prepaidSource.id !== "credits:one_off") return false;

          if (prepaidSource.kind !== "one_off") return false;

          if (prepaidSource.granted !== prepaid) return false;

          if (prepaidSource.remaining !== Math.min(prepaid, Math.max(0, remaining))) {
            return false;
          }

          if (prepaidSource.interval !== "never") return false;
        }

        // The one-off source never claims more than the pool holds, and the
        // two sources together are the pool's grant.
        if (
          sumOf(balance.breakdown.map((source) => source.granted ?? 0)) !==
          planGranted + prepaid
        ) {
          return false;
        }

        if (balance.granted !== c.credits) return false;

        if (balance.remaining !== c.remaining) return false;

        if (balance.usage !== c.used) return false;

        if (balance.unlimited !== false) return false;

        if (balance.overageAllowed !== (c.overage !== "block")) return false;

        if (balance.nextResetAt !== (c.hasResetAt ? resetAt : null)) return false;

        if (!spendLimitHolds(balance, feature)) return false;

        return sourcesTieOut(balance);
      },
      { runs: 120, size: 36 },
    ),
  );
});

// ---------------------------------------------------------------------------
// A seat
// ---------------------------------------------------------------------------

const SeatCase = Schema.Struct({
  purchased: Count,
  occupied: Count,
  rows: Schema.Array(PlanRow).pipe(Schema.check(Schema.isMaxLength(3))),
  listed: Schema.Boolean,
  overage: Overage,
  spendLimit: Schema.optionalKey(Count),
  billed: Count,
});

type SeatCase = typeof SeatCase.Type;

const seatOf = (c: SeatCase): BalanceFeature => {
  const rows = planRowsOf(c.rows);
  const included = c.rows.reduce((total, row) => total + row.included, 0);

  return {
    overage: c.overage,
    included,
    remaining: c.purchased - c.occupied,
    used: c.occupied,
    kind: "non_consumable",
    quantity: c.purchased,
    resets: "never",
    resetsAt: null,
    ...(rows.length > 0 ? { planSources: rows } : c.listed ? { planSources: [] } : {}),
    ...(c.spendLimit === undefined ? {} : { spendLimit: c.spendLimit }),
    ...(c.spendLimit === undefined ? {} : { billed: c.billed }),
  };
};

describe("a seat", () => {
  it.effect("reports the purchase and occupancy, and splits the purchase by plan", () =>
    assertProperty(
      Arbitrary.schema(SeatCase),
      (c) => {
        const feature = seatOf(c);
        const balance = balanceOfFeature(account, featureId, feature, plan);
        const remaining = c.purchased - c.occupied;

        if (balance.purchased !== c.purchased) return false;

        if (balance.occupied !== c.occupied) return false;

        if (balance.granted !== c.purchased) return false;

        if (balance.remaining !== remaining) return false;

        if (balance.usage !== c.occupied) return false;

        if (balance.unlimited !== false) return false;

        if (balance.overageAllowed !== (c.overage !== "block")) return false;

        if (balance.nextResetAt !== null) return false;

        if (c.rows.length === 0) {
          if (balance.breakdown.length !== 1) return false;

          const [source] = balance.breakdown;

          if (source === undefined) return false;

          if (source.kind !== "plan") return false;

          if (source.planId !== tier) return false;

          if (source.granted !== c.purchased) return false;

          if (source.remaining !== remaining) return false;

          if (source.usage !== c.occupied) return false;
        } else {
          if (balance.breakdown.length !== c.rows.length) return false;

          if (balance.breakdown.some((source) => source.kind !== "plan")) return false;

          if (balance.breakdown.some((source, index) => source.planId !== `plan-${index}`)) {
            return false;
          }

          if (sumOf(grantedOf(balance).map((granted) => granted ?? 0)) !== c.purchased) {
            return false;
          }

          // The last plan takes what the earlier ones could not fit, so the
          // split always adds back up to the purchase.
          const last = balance.breakdown[balance.breakdown.length - 1];

          if (last === undefined) return false;

          if (
            last.granted !==
            c.purchased - sumOf(balance.breakdown.slice(0, -1).map((source) => source.granted ?? 0))
          ) {
            return false;
          }

          if (sumOf(remainingOf(balance).map((left) => left ?? 0)) !== Math.max(0, remaining)) {
            return false;
          }

          if (
            last.remaining !==
            Math.max(0, remaining) -
              sumOf(balance.breakdown.slice(0, -1).map((source) => source.remaining ?? 0))
          ) {
            return false;
          }

          if (balance.breakdown.some((source) => (source.remaining ?? 0) < 0)) return false;
        }

        if (!spendLimitHolds(balance, feature)) return false;

        return sourcesTieOut(balance);
      },
      { runs: 120, size: 36 },
    ),
  );
});

// ---------------------------------------------------------------------------
// A flag
// ---------------------------------------------------------------------------

const FlagCase = Schema.Struct({
  overage: Overage,
  hasResetAt: Schema.Boolean,
  spendLimit: Schema.optionalKey(Count),
  billed: Count,
  quantity: Count,
  used: Count,
});

type FlagCase = typeof FlagCase.Type;

const flagOf = (c: FlagCase): BalanceFeature => ({
  overage: c.overage,
  included: "unlimited",
  remaining: c.used,
  used: c.used,
  kind: "flag",
  quantity: c.quantity,
  resets: "month",
  resetsAt: c.hasResetAt ? resetAt : null,
  ...(c.spendLimit === undefined ? {} : { spendLimit: c.spendLimit }),
  ...(c.spendLimit === undefined ? {} : { billed: c.billed }),
});

describe("a flag", () => {
  it.effect("has no count at all, and a spend limit is still money", () =>
    assertProperty(
      Arbitrary.schema(FlagCase),
      (c) => {
        const feature = flagOf(c);
        const balance = balanceOfFeature(account, featureId, feature, plan);

        if (balance.granted !== null) return false;

        if (balance.remaining !== null) return false;

        if (balance.usage !== 0) return false;

        if (balance.unlimited !== true) return false;

        if (balance.overageAllowed !== false) return false;

        if (balance.nextResetAt !== null) return false;

        if (balance.breakdown.length !== 0) return false;

        if (!spendLimitHolds(balance, feature)) return false;

        return sourcesTieOut(balance);
      },
      { runs: 100, size: 24 },
    ),
  );
});

// ---------------------------------------------------------------------------
// A spend limit
// ---------------------------------------------------------------------------

const SpendLimitCase = Schema.Struct({
  amount: Count,
  billed: Count,
  hasLimit: Schema.Boolean,
});

type SpendLimitCase = typeof SpendLimitCase.Type;

describe("a spend limit", () => {
  it.effect("is the money headroom left under the customer's ceiling", () =>
    assertProperty(
      Arbitrary.schema(SpendLimitCase),
      (c) => {
        const feature: BalanceFeature = {
          overage: "bill",
          included: 50,
          remaining: 50,
          resets: "month",
          resetsAt: null,
          billed: c.billed,
          ...(c.hasLimit ? { spendLimit: c.amount } : {}),
        };

        const balance = balanceOfFeature(account, featureId, feature, plan);

        if (!c.hasLimit) return balance.spendLimit === undefined;

        return (
          balance.spendLimit?.amount === c.amount &&
          balance.spendLimit.remaining === Math.max(0, c.amount - c.billed)
        );
      },
      { runs: 100, size: 20 },
    ),
  );
});

// ---------------------------------------------------------------------------
// balanceOf, balancesOf and emptyBalance
// ---------------------------------------------------------------------------

const FeaturesCase = Schema.Struct({
  features: Schema.Array(CountedCase).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  ),
});

type FeaturesCase = typeof FeaturesCase.Type;

const stateOf = (features: Readonly<Record<string, BalanceFeature>>): EntitlementsState =>
  ({
    account,
    tier,
    credits: 0,
    prepaidCredits: 0,
    features,
  }) as unknown as EntitlementsState;

describe("the feature list", () => {
  it.effect("reads each feature by key, in the view's own order", () =>
    assertProperty(
      Arbitrary.schema(FeaturesCase),
      (c) => {
        const features: Record<string, BalanceFeature> = {};
        const ids: Array<string> = [];

        for (const [index, row] of c.features.entries()) {
          const id = `feature-${index}`;

          ids.push(id);
          features[id] = countedOf(row).feature;
        }

        const state = stateOf(features);
        const balances = balancesOf(state);

        if (balances.length !== ids.length) return false;

        if (balances.map((balance) => balance.featureId).join("|") !== ids.join("|")) {
          return false;
        }

        for (const [index, balance] of balances.entries()) {
          const id = ids[index];
          const feature = id === undefined ? undefined : features[id];

          if (id === undefined || feature === undefined) return false;

          const expected = balanceOfFeature(account, id, feature, plan);

          if (balance.granted !== expected.granted) return false;

          if (balance.remaining !== expected.remaining) return false;

          if (balance.usage !== expected.usage) return false;

          if (balance.scope.kind !== "customer") return false;

          if (balance.breakdown.length !== expected.breakdown.length) return false;

          if (balance.breakdown.some((source, at) => source.id !== expected.breakdown[at]?.id)) {
            return false;
          }
        }

        return balanceOf(state, "not-in-the-view") === null;
      },
      { runs: 80, size: 32 },
    ),
  );
});

const EmptyCase = Schema.Struct({
  customerId: Schema.Literals(["acct-a", "acct-b"]),
  featureId: Schema.Literals(["messages", "seats", "sso"]),
});

type EmptyCase = typeof EmptyCase.Type;

describe("an empty balance", () => {
  it.effect("has no source and no count, and keeps the scope it was asked for", () =>
    assertProperty(
      Arbitrary.schema(EmptyCase),
      (c) => {
        const balance = emptyBalance(c.customerId, c.featureId);

        if (balance.customerId !== c.customerId) return false;

        if (balance.featureId !== c.featureId) return false;

        if (balance.scope.kind !== "customer") return false;

        if (balance.granted !== 0) return false;

        if (balance.remaining !== 0) return false;

        if (balance.usage !== 0) return false;

        if (balance.unlimited !== false) return false;

        if (balance.overageAllowed !== false) return false;

        if (balance.nextResetAt !== null) return false;

        if (balance.breakdown.length !== 0) return false;

        if (balance.purchased !== undefined) return false;

        if (balance.occupied !== undefined) return false;

        if (balance.spendLimit !== undefined) return false;

        return sourcesTieOut(balance);
      },
      { runs: 50, size: 20 },
    ),
  );
});
