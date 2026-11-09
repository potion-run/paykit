import * as Schema from "effect/Schema";
import { Allowances, type Allowance, type Included } from "../Allowance.ts";
import { CreditRateCards } from "../Feature.ts";
import type { RateCard } from "../Feature.ts";
import { CreditsExpire, Interval, Price, TopUpTerms } from "../Tier.ts";

/**
 * The group a plan belongs to when it states none. A catalog may name as many
 * groups as it sells, and one of them is the account's base: the default group
 * holds the plan a cancellation falls back to and the plan `check` reads first
 * (ADR 0039 §1).
 */
export const DEFAULT_PLAN_GROUP = "default";

/**
 * One active plan, with the terms the boundary needs to move to it without a
 * catalog. The standing holds a row per active plan, keyed by plan id, and at
 * most one row per group is a base plan: the rest are add-ons that stack beside
 * every group (ADR 0039 §1–2).
 */
export const PlanRow = Schema.Struct({
  /** The catalog plan this row was sold as. */
  planId: Schema.String,
  /** The group a move to another plan replaces within. */
  group: Schema.String,
  /** Whether this plan stacks beside every group instead of filling one. */
  addOn: Schema.Boolean,
  /** What the plan grants, per feature. */
  allowances: Allowances,
  /** What the plan costs. Absent on a free plan. */
  price: Schema.optionalKey(Price),
  /** The pool this plan grants at activation or at a boundary. */
  credits: Schema.Int,
  /** Whether that pool expires at a period close. */
  creditsExpire: CreditsExpire,
  /** Credits at or below which a spend buys the deployment's auto top-up pack. */
  topUp: Schema.optionalKey(TopUpTerms),
  /** Every credit-priced feature's rate card, as this plan states it. */
  rates: CreditRateCards,
  /** The cadence the plan was sold with. */
  interval: Schema.optionalKey(Interval),
  /** The currency the plan is priced in. */
  currency: Schema.optionalKey(Schema.String),
});

export type PlanRow = typeof PlanRow.Type;

/** Every active plan, keyed by plan id, one base plan per group at most. */
export const Plans = Schema.Record(Schema.String, PlanRow);

export type Plans = typeof Plans.Type;

/**
 * One phase of a plan schedule: the plan a group moves to, the instant it
 * starts, and the terms that move carries. A phase is future-only and the list
 * is ordered, so at most one phase starts at any instant (ADR 0039 §3).
 */
export const PlanPhase = Schema.Struct({
  ...PlanRow.fields,
  /** When the phase starts. The scheduler applies it at this instant. */
  at: Schema.DateTimeUtc,
});

export type PlanPhase = typeof PlanPhase.Type;

/** The phases an account will move through, in the order they start. */
export const PlanSchedule = Schema.Array(PlanPhase);

export type PlanSchedule = typeof PlanSchedule.Type;

const byPlanId = (a: PlanRow, b: PlanRow): number =>
  a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0;

/**
 * Every row in the order a merge reads them: the default group's plan first
 * (its pricing and reset rules are the account's), then every other group's
 * plan, then the add-ons. The order is the rule, not the insertion order, so a
 * replayed log and a live state merge the same way.
 */
export const planOrder = (plans: Plans | undefined): ReadonlyArray<PlanRow> => {
  // A standing written before the plan set existed decodes into an empty set;
  // every reader below tolerates it rather than throwing on an old record.
  const rows = Object.values(plans ?? {}).sort(byPlanId);
  const base = rows.filter((row) => !row.addOn);
  const addOns = rows.filter((row) => row.addOn);
  const primary = base.find((row) => row.group === DEFAULT_PLAN_GROUP);

  return [
    ...(primary === undefined ? [] : [primary]),
    ...base.filter((row) => row.planId !== primary?.planId),
    ...addOns,
  ];
};

/** The base plan of one group, or `undefined` when the group holds none. */
export const planInGroup = (plans: Plans | undefined, group: string): PlanRow | undefined =>
  Object.values(plans ?? {}).find((row) => row.group === group && !row.addOn);

/** The plan `check` reads first: the default group's, else any base plan. */
export const primaryPlan = (plans: Plans | undefined): PlanRow | undefined =>
  planInGroup(plans, DEFAULT_PLAN_GROUP) ?? Object.values(plans ?? {}).find((row) => !row.addOn);

/** Every add-on currently attached. */
export const addOnPlans = (plans: Plans | undefined): ReadonlyArray<PlanRow> =>
  Object.values(plans ?? {})
    .filter((row) => row.addOn)
    .sort(byPlanId);

/** The ids of every active plan, base or add-on. */
export const planIds = (plans: Plans): ReadonlyArray<string> =>
  planOrder(plans).map((row) => row.planId);

/**
 * Whether two plan items for one feature can share a balance. A flag and a
 * count cannot, and neither can two items that spend one feature differently:
 * the merged count would have no single answer for what "past included" means.
 * This is the interim rule until the balance ledger reports one source per plan
 * (ADR 0035 §4); a conflict is refused at attach rather than merged.
 */
export const sameSpendShape = (a: Allowance, b: Allowance): boolean =>
  (a.kind ?? "metered") === (b.kind ?? "metered") &&
  a.overage === b.overage &&
  a.resets === b.resets &&
  (a.resetEvery ?? 1) === (b.resetEvery ?? 1) &&
  JSON.stringify(a.pricing ?? null) === JSON.stringify(b.pricing ?? null);

const addIncluded = (a: Included, b: Included): Included =>
  a === "unlimited" || b === "unlimited" ? "unlimited" : a + b;

/**
 * One feature's item across several plans. The first plan (the default group's)
 * states the spend rules — overage, pricing, reset and currency — and every
 * add-on adds its included amount. A feature two plans price differently is not
 * merged silently: `sameSpendShape` is what an attach checks before it writes.
 */
const mergeAllowance = (base: Allowance, extra: Allowance): Allowance => ({
  ...base,
  included: addIncluded(base.included, extra.included),
  ...(base.cap === undefined && extra.cap === undefined
    ? {}
    : { cap: Math.max(base.cap ?? 0, extra.cap ?? 0) }),
  // A pooled item stays pooled through the merge: it is one source every
  // attached entity draws on, not a per-plan grant (ADR 0040 §3).
  ...(base.pooled === true || extra.pooled === true ? { pooled: true } : {}),
});

/**
 * The allowances a spend path reads: every active plan's items, merged by
 * feature. One plan is the ordinary case and merges to itself; an add-on adds
 * its included amount to the feature it grants.
 */
export const mergeAllowances = (plans: Plans | undefined): Allowances => {
  const merged: Record<string, Allowance> = {};

  for (const row of planOrder(plans)) {
    for (const [feature, allowance] of Object.entries(row.allowances)) {
      const existing = merged[feature];
      merged[feature] = existing === undefined ? allowance : mergeAllowance(existing, allowance);
    }
  }

  return merged;
};

/**
 * Every plan's rate cards, the add-ons' last so their rates apply to their
 * features. Each row's cards are already a `CreditRateCards` record, so the
 * spread of them is one too.
 */
export const mergeRates = (plans: Plans | undefined): CreditRateCards => {
  const merged: Record<string, RateCard> = {};

  for (const row of planOrder(plans)) {
    Object.assign(merged, row.rates);
  }

  return merged;
};

/** The active plan of one group, replaced by a row that names the same group. */
export const withPlan = (plans: Plans | undefined, row: PlanRow): Plans => {
  const replaced = Object.entries(plans ?? {}).filter(
    ([id, existing]) =>
      id === row.planId ||
      (existing.group === row.group && !existing.addOn && !row.addOn) === false,
  );

  return Object.fromEntries([...replaced, [row.planId, row]]);
};

/** Drop one plan, whether it is a group's plan or an add-on. */
export const withoutPlan = (plans: Plans, planId: string): Plans =>
  Object.fromEntries(Object.entries(plans).filter(([id]) => id !== planId));

/** Drop the base plan of a group, leaving its add-ons alone. */
export const withoutGroup = (plans: Plans, group: string): Plans =>
  Object.fromEntries(Object.entries(plans).filter(([, row]) => row.group !== group || row.addOn));

/** The phases of one group, in the order they start. */
export const phasesOfGroup = (
  schedule: PlanSchedule | undefined,
  group: string,
): ReadonlyArray<PlanPhase> => (schedule ?? []).filter((phase) => phase.group === group);

/**
 * Add a phase, keeping the list ordered by instant. A phase for a plan that is
 * already scheduled moves that phase instead of adding a second one for the
 * same plan; two phases at the same instant are the caller's to avoid, and the
 * decision refuses them (`PlanPhaseAtSameInstant`).
 */
export const withPhase = (schedule: PlanSchedule | undefined, phase: PlanPhase): PlanSchedule =>
  [...(schedule ?? []).filter((existing) => existing.planId !== phase.planId), phase].sort((a, b) =>
    a.at.epochMilliseconds < b.at.epochMilliseconds ? -1 : 1,
  );

/** Drop one plan's pending phase. */
export const withoutPhase = (schedule: PlanSchedule | undefined, planId: string): PlanSchedule =>
  (schedule ?? []).filter((phase) => phase.planId !== planId);

/** Drop every phase a group still has waiting. A move or cancel supersedes them. */
export const withoutGroupPhases = (
  schedule: PlanSchedule | undefined,
  group: string,
): PlanSchedule => (schedule ?? []).filter((phase) => phase.group !== group);

/**
 * The phases due at or before an instant, in order. A boundary applies them
 * before it resets the counters, so the next period starts on the plan it
 * lands on.
 */
/** The phases due at or before an instant, in start order. */
export const duePhases = (
  schedule: PlanSchedule | undefined,
  atMs: number,
): ReadonlyArray<PlanPhase> =>
  (schedule ?? [])
    .filter((phase) => phase.at.epochMilliseconds <= atMs)
    .sort((a, b) => a.at.epochMilliseconds - b.at.epochMilliseconds);

/** The first phase still ahead of an instant. */
export const nextPhase = (
  schedule: PlanSchedule | undefined,
  atMs: number,
): PlanPhase | undefined =>
  (schedule ?? [])
    .filter((phase) => phase.at.epochMilliseconds > atMs)
    .sort((a, b) => a.at.epochMilliseconds - b.at.epochMilliseconds)[0];
