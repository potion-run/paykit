import type * as DateTime from "effect/DateTime";
import type { Allowances } from "../../src/Allowance.ts";
import {
  DEFAULT_PLAN_GROUP,
  type PlanPhase,
  type PlanRow,
  type Plans,
  primaryPlan,
  withPlan,
} from "../../src/Subscription/PlanSet.ts";
import type { SubscribedState } from "../../src/Subscription/Subscription.state.ts";

/**
 * One plan row for a test state. The migrations that used to write `tier` and
 * `allowances` on the standing now write a row per plan (ADR 0039), so a test
 * that builds a state names the plan it sells and its group.
 */
export const planRow = (planId: string, overrides: Partial<PlanRow> = {}): PlanRow => ({
  planId,
  version: 1,
  group: DEFAULT_PLAN_GROUP,
  addOn: false,
  allowances: {} as Allowances,
  credits: 0,
  creditsExpire: "period",
  rates: {},
  ...overrides,
});

/** A plan set from rows, keyed by plan id. */
export const planSet = (...rows: ReadonlyArray<PlanRow>): Plans =>
  Object.fromEntries(rows.map((row) => [row.planId, row]));

/** The plan set of one sold plan, the ordinary case. */
export const soldPlan = (planId: string, overrides: Partial<PlanRow> = {}): Plans =>
  planSet(planRow(planId, overrides));

/** One phase of a schedule, with the terms a boundary needs. */
export const planPhase = (
  planId: string,
  at: DateTime.Utc,
  overrides: Partial<PlanRow> = {},
): PlanPhase => ({ ...planRow(planId, overrides), at });

/** A state whose sold plan carries `patch`, for a test that varies one term. */
export const withSoldPlan = (state: SubscribedState, patch: Partial<PlanRow>): SubscribedState => {
  const sold = primaryPlan(state.plans);

  return sold === undefined
    ? state
    : { ...state, plans: withPlan(state.plans, { ...sold, ...patch }) };
};
