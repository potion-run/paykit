import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { type Allowance, type Allowances, type Pricing } from "../../src/Allowance.ts";
import { type CreditRateCards, type RateCard } from "../../src/Feature.ts";
import { FeatureId } from "../../src/Feature.ts";
import {
  DEFAULT_PLAN_GROUP,
  addOnPlans,
  duePhases,
  mergeAllowances,
  mergeRates,
  nextPhase,
  phasesOfGroup,
  planIds,
  planInGroup,
  planOrder,
  primaryPlan,
  sameSpendShape,
  withPhase,
  withPlan,
  withoutGroup,
  withoutGroupPhases,
  withoutPhase,
  withoutPlan,
  type PlanPhase,
  type PlanRow,
  type Plans,
} from "../../src/Subscription/PlanSet.ts";
import { planPhase, planRow } from "../support/Plans.ts";
import { assertProperty } from "../support/Property.ts";

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const ascending = (values: ReadonlyArray<string>): boolean =>
  values.every((value, index) => index === 0 || values[index - 1]! <= value);

const comparePlanIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** A plan set whose keys are its rows' plan ids, and whose base groups are unique. */
const buildPlans = (specs: ReadonlyArray<PlanSpec>): Plans =>
  Object.fromEntries(
    specs.map((spec, index) => {
      const planId = `p${index}`;
      // A base plan fills its own group, so a generated set never has two base
      // plans competing for one slot. An add-on may name any group it stacks
      // beside, including the default one.
      const group = spec.addOn ? spec.group : index === 0 ? DEFAULT_PLAN_GROUP : `g${index}`;

      return [
        planId,
        planRow(planId, {
          group,
          addOn: spec.addOn,
          allowances: grantsOf(spec.grants),
          rates: buildRates(spec.rates),
          credits: spec.credits,
          creditsExpire: spec.creditsExpire,
        }),
      ];
    }),
  );

/** The same plan set written in the opposite insertion order. */
const reversedPlans = (plans: Plans): Plans => Object.fromEntries(Object.entries(plans).reverse());

const FeatureNames = Schema.Literals(["alpha", "beta", "gamma"]);

const IncludedSpec = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  Schema.Literal("unlimited"),
]);

const AllowanceSpec = Schema.Struct({
  feature: FeatureNames,
  kind: Schema.Literals(["metered", "flag", "non_consumable"]),
  included: IncludedSpec,
  overage: Schema.Literals(["block", "bill", "allow"]),
  resets: Schema.Literals(["month", "annual", "never"]),
  resetEvery: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
  ),
  pooled: Schema.optionalKey(Schema.Boolean),
  cap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 40 }))),
  ),
  price: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  ),
});

type AllowanceSpec = typeof AllowanceSpec.Type;

const unitPricing = (amount: number): Pricing => ({
  _tag: "unit",
  unitPrice: { amount, currency: "usd" },
});

const buildAllowance = (spec: AllowanceSpec): Allowance => ({
  feature: FeatureId.make(spec.feature),
  kind: spec.kind,
  included: spec.included,
  // An allowance that never runs out has nothing to block or bill past its end.
  overage: spec.included === "unlimited" ? "allow" : spec.overage,
  resets: spec.resets,
  ...(spec.resetEvery === undefined || spec.resets === "never"
    ? {}
    : { resetEvery: spec.resetEvery }),
  ...(spec.pooled === undefined ? {} : { pooled: spec.pooled }),
  ...(spec.included !== "unlimited" && spec.cap !== undefined ? { cap: spec.cap } : {}),
  ...(spec.price === undefined ? {} : { pricing: unitPricing(spec.price) }),
});

const grantsOf = (specs: ReadonlyArray<AllowanceSpec>): Allowances =>
  Object.fromEntries(specs.map((spec) => [spec.feature, buildAllowance(spec)]));

const RateSpec = Schema.Struct({
  feature: FeatureNames,
  rate: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 30 }))),
});

type RateSpec = typeof RateSpec.Type;

const buildRateCard = (spec: RateSpec): RateCard => ({ default: spec.rate });

const buildRates = (specs: ReadonlyArray<RateSpec>): CreditRateCards =>
  Object.fromEntries(specs.map((spec) => [spec.feature, buildRateCard(spec)]));

const PlanSpec = Schema.Struct({
  addOn: Schema.Boolean,
  group: Schema.Literals(["default", "g1", "g2", "extra"]),
  grants: Schema.Array(AllowanceSpec).pipe(Schema.check(Schema.isMaxLength(4))),
  rates: Schema.Array(RateSpec).pipe(Schema.check(Schema.isMaxLength(4))),
  credits: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
  creditsExpire: Schema.Literals(["period", "never"]),
});

type PlanSpec = typeof PlanSpec.Type;

const PlanSetSpec = Schema.Array(PlanSpec).pipe(Schema.check(Schema.isMaxLength(5)));

/** Fixed instants, so a generated schedule never reads the wall clock. */
const INSTANTS: ReadonlyArray<DateTime.Utc> = [
  DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
  DateTime.makeUnsafe("2030-02-01T00:00:00Z"),
  DateTime.makeUnsafe("2030-03-01T00:00:00Z"),
  DateTime.makeUnsafe("2030-04-01T00:00:00Z"),
  DateTime.makeUnsafe("2030-05-01T00:00:00Z"),
  DateTime.makeUnsafe("2030-06-01T00:00:00Z"),
];

const TimeIndex = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: INSTANTS.length - 1 })),
);

const PhaseSpec = Schema.Struct({
  planId: Schema.Literals(["e0", "e1", "e2", "e3", "e4", "next"]),
  group: Schema.Literals(["default", "g1", "g2", "extra"]),
  addOn: Schema.Boolean,
  at: TimeIndex,
});

type PhaseSpec = typeof PhaseSpec.Type;

const buildPhase = (spec: PhaseSpec): PlanPhase =>
  planPhase(spec.planId, INSTANTS[spec.at]!, {
    group: spec.group,
    addOn: spec.addOn,
  });

const ScheduleSpec = Schema.Array(PhaseSpec).pipe(Schema.check(Schema.isMaxLength(6)));

describe("plan order", () => {
  it.effect("visits every row exactly once, default group first and add-ons last", () =>
    assertProperty(
      Arbitrary.schema(PlanSetSpec),
      (specs) => {
        const plans = buildPlans(specs);
        const rows = Object.values(plans);
        const order = planOrder(plans);

        if (order.length !== rows.length) return false;

        if (new Set(order.map((row) => row.planId)).size !== rows.length) return false;

        if (!rows.every((row) => order.includes(row))) return false;

        if (
          !same(
            planIds(plans),
            order.map((row) => row.planId),
          )
        )
          return false;

        const bases = order.filter((row) => !row.addOn);
        const addOns = order.filter((row) => row.addOn);
        const firstAddOn = order.findIndex((row) => row.addOn);

        // Every base plan comes before every add-on.
        if (firstAddOn !== -1 && order.slice(firstAddOn).some((row) => !row.addOn)) return false;

        const defaultBase = rows.find((row) => !row.addOn && row.group === DEFAULT_PLAN_GROUP);

        // A default group's plan leads, and the remaining bases and add-ons are
        // each ordered by plan id rather than by insertion order.
        if (defaultBase !== undefined && order[0]?.planId !== defaultBase.planId) return false;

        if (
          !ascending((defaultBase === undefined ? bases : bases.slice(1)).map((row) => row.planId))
        )
          return false;

        if (!ascending(addOns.map((row) => row.planId))) return false;

        return same(order, planOrder(plans)) && same(order, planOrder(reversedPlans(plans)));
      },
      { runs: 80, size: 30 },
    ),
  );

  it.effect("selects each group's base plan, the primary and every add-on", () =>
    assertProperty(
      Arbitrary.schema(PlanSetSpec),
      (specs) => {
        const plans = buildPlans(specs);
        const rows = Object.values(plans);
        const groups = new Set([DEFAULT_PLAN_GROUP, ...rows.map((row) => row.group)]);

        for (const group of groups) {
          const base = rows.find((row) => row.group === group && !row.addOn);
          const selected = planInGroup(plans, group);

          if (base === undefined) {
            if (selected !== undefined) return false;
          } else if (selected === undefined || selected.planId !== base.planId) {
            return false;
          }
        }

        const expectedAddOns = rows
          .filter((row) => row.addOn)
          .sort((left, right) => comparePlanIds(left.planId, right.planId));

        if (!same(addOnPlans(plans), expectedAddOns)) return false;

        const bases = rows.filter((row) => !row.addOn);
        const primary = primaryPlan(plans);
        const defaultBase = planInGroup(plans, DEFAULT_PLAN_GROUP);

        if (defaultBase !== undefined) {
          if (primary === undefined || primary.planId !== defaultBase.planId) return false;
        } else if (bases.length === 0) {
          if (primary !== undefined) return false;
        } else if (primary === undefined || primary.planId !== bases[0]!.planId) {
          return false;
        }

        // A primary is always a base plan, never an add-on.
        return primary === undefined || !primary.addOn;
      },
      { runs: 80, size: 30 },
    ),
  );

  it("treats a missing plan set as empty", () => {
    expect(planOrder(undefined)).toEqual([]);
    expect(planIds({})).toEqual([]);
    expect(primaryPlan(undefined)).toBeUndefined();
    expect(planInGroup(undefined, DEFAULT_PLAN_GROUP)).toBeUndefined();
    expect(addOnPlans(undefined)).toEqual([]);
    expect(mergeAllowances(undefined)).toEqual({});
    expect(mergeRates(undefined)).toEqual({});
  });
});

describe("merged allowances", () => {
  it.effect("sums included, absorbs unlimited, keeps the max cap and propagates pooled", () =>
    assertProperty(
      Arbitrary.schema(PlanSetSpec),
      (specs) => {
        const plans = buildPlans(specs);
        const rows = planOrder(plans);
        const merged = mergeAllowances(plans);
        const features = new Set(rows.flatMap((row) => Object.keys(row.allowances)));

        if (Object.keys(merged).length !== features.size) return false;

        for (const feature of features) {
          const grants = rows
            .map((row) => row.allowances[feature])
            .filter((allowance): allowance is Allowance => allowance !== undefined);

          const actual = merged[feature];

          if (actual === undefined || grants.length === 0) return false;

          const first = grants[0]!;

          const included = grants.some((allowance) => allowance.included === "unlimited")
            ? "unlimited"
            : grants.reduce((total, allowance) => total + (allowance.included as number), 0);

          if (actual.included !== included) return false;

          const caps = grants
            .map((allowance) => allowance.cap)
            .filter((cap): cap is number => cap !== undefined);

          if (caps.length === 0) {
            if (actual.cap !== undefined) return false;
          } else if (actual.cap !== Math.max(...caps)) {
            return false;
          }

          const pooled = grants.some((allowance) => allowance.pooled === true);

          if ((actual.pooled === true) !== pooled) return false;

          if (!pooled && actual.pooled !== first.pooled) return false;

          // Everything but the merged count, cap and pool is the spend shape of
          // the first plan in `planOrder`.
          if (actual.kind !== first.kind) return false;

          if (actual.overage !== first.overage) return false;

          if (actual.resets !== first.resets) return false;

          if (actual.resetEvery !== first.resetEvery) return false;

          if (actual.carryOver !== first.carryOver) return false;

          if (actual.carryCap !== first.carryCap) return false;

          if (actual.prorate !== first.prorate) return false;

          if (actual.moneyCap !== first.moneyCap) return false;

          if (!same(actual.pricing, first.pricing)) return false;

          if (!same(actual.unitPrice, first.unitPrice)) return false;
        }

        // The default group's plan leads the merge, so its own grants state the
        // spend rules even when an add-on grants more of the same feature.
        const defaultBase = planInGroup(plans, DEFAULT_PLAN_GROUP);

        if (defaultBase !== undefined) {
          for (const [feature, allowance] of Object.entries(defaultBase.allowances)) {
            const actual = merged[feature];

            if (actual === undefined) return false;

            if (actual.overage !== allowance.overage) return false;

            if (actual.resets !== allowance.resets) return false;

            if (actual.resetEvery !== allowance.resetEvery) return false;

            if (!same(actual.pricing, allowance.pricing)) return false;
          }
        }

        return true;
      },
      { runs: 80, size: 35 },
    ),
  );

  it.effect("merges the same set whatever order the rows were written in", () =>
    assertProperty(
      Arbitrary.schema(PlanSetSpec),
      (specs) => {
        const plans = buildPlans(specs);
        const reversed = reversedPlans(plans);

        return (
          same(planOrder(plans), planOrder(reversed)) &&
          same(planIds(plans), planIds(reversed)) &&
          same(mergeAllowances(plans), mergeAllowances(reversed)) &&
          same(mergeRates(plans), mergeRates(reversed))
        );
      },
      { runs: 60, size: 30 },
    ),
  );
});

describe("merged rates", () => {
  it.effect("takes the union of features and the last card in plan order", () =>
    assertProperty(
      Arbitrary.schema(PlanSetSpec),
      (specs) => {
        const plans = buildPlans(specs);
        const rows = planOrder(plans);
        const merged = mergeRates(plans);
        const features = new Set(rows.flatMap((row) => Object.keys(row.rates)));

        if (Object.keys(merged).length !== features.size) return false;

        for (const feature of features) {
          const winner = [...rows].reverse().find((row) => row.rates[feature] !== undefined);

          if (winner === undefined) return false;

          if (!same(merged[feature], winner.rates[feature])) return false;
        }

        return true;
      },
      { runs: 70, size: 30 },
    ),
  );
});

const WithPlanSpec = Schema.Struct({
  plans: Schema.Array(PlanSpec).pipe(Schema.check(Schema.isMaxLength(4))),
  incoming: PlanSpec,
  target: Schema.Literals(["p0", "p1", "p2", "p3", "p4", "next"]),
});

const incomingRow = (spec: PlanSpec, planId: string): PlanRow =>
  planRow(planId, {
    group: spec.group,
    addOn: spec.addOn,
    allowances: grantsOf(spec.grants),
    rates: buildRates(spec.rates),
    credits: spec.credits,
    creditsExpire: spec.creditsExpire,
  });

describe("withPlan", () => {
  it.effect(
    "replaces the group's base plan, keeps its add-ons and other groups, and is idempotent",
    () =>
      assertProperty(
        Arbitrary.schema(WithPlanSpec),
        ({ plans: specs, incoming, target }) => {
          const plans = buildPlans(specs);
          const row = incomingRow(incoming, target === "next" ? "p_next" : target);
          const result = withPlan(plans, row);

          if (result[row.planId] !== row) return false;

          for (const [id, existing] of Object.entries(plans)) {
            // The incoming row's own id is replaced whatever group it came from.
            if (id === row.planId) continue;

            const occupied = existing.group === row.group && !existing.addOn && !row.addOn;

            if (occupied) {
              if (result[id] !== undefined) return false;
            } else if (result[id] !== existing) {
              return false;
            }
          }

          const expectedKeys = Object.keys(plans).filter((id) => {
            const existing = plans[id]!;
            const occupied = existing.group === row.group && !existing.addOn && !row.addOn;

            return id !== row.planId && !occupied;
          });

          if (Object.keys(result).length !== expectedKeys.length + 1) return false;

          // A second application sees the row it just wrote and changes nothing.
          const again = withPlan(result, row);

          return same(again, result);
        },
        { runs: 70, size: 30 },
      ),
  );
});

const RemovalSpec = Schema.Struct({
  plans: Schema.Array(PlanSpec).pipe(Schema.check(Schema.isMaxLength(5))),
  planId: Schema.Literals(["p0", "p1", "p2", "p3", "p4", "absent"]),
  group: Schema.Literals(["default", "g1", "g2", "extra", "absent"]),
});

describe("withoutPlan and withoutGroup", () => {
  it.effect("remove exactly the named plan or the named group's base", () =>
    assertProperty(
      Arbitrary.schema(RemovalSpec),
      ({ plans: specs, planId, group }) => {
        const plans = buildPlans(specs);
        const without = withoutPlan(plans, planId);
        const remainingIds = Object.keys(plans).filter((id) => id !== planId);

        if (!same(Object.keys(without), remainingIds)) return false;

        for (const id of remainingIds) {
          if (!same(without[id], plans[id])) return false;
        }

        const withoutGrouped = withoutGroup(plans, group);

        for (const [id, existing] of Object.entries(plans)) {
          const kept = withoutGrouped[id] !== undefined;

          if (kept !== (existing.group !== group || existing.addOn)) return false;

          if (kept && withoutGrouped[id] !== existing) return false;
        }

        return (
          Object.keys(withoutGrouped).length ===
          Object.values(plans).filter((existing) => existing.group !== group || existing.addOn)
            .length
        );
      },
      { runs: 70, size: 30 },
    ),
  );
});

describe("sameSpendShape", () => {
  it.effect("is reflexive and symmetric", () =>
    assertProperty(
      Arbitrary.schema(Schema.Struct({ left: AllowanceSpec, right: AllowanceSpec })),
      ({ left, right }) => {
        const a = buildAllowance(left);
        const b = buildAllowance(right);

        return sameSpendShape(a, a) && sameSpendShape(a, b) === sameSpendShape(b, a);
      },
      { runs: 80, size: 30 },
    ),
  );

  it.effect("is false for a different kind, overage, reset, reset cadence or price", () =>
    assertProperty(
      Arbitrary.schema(AllowanceSpec),
      (spec) => {
        const base = buildAllowance(spec);

        const kind: Allowance = {
          ...base,
          kind: (base.kind ?? "metered") === "metered" ? "flag" : "metered",
        };

        const overage: Allowance = {
          ...base,
          overage: base.overage === "block" ? "allow" : "block",
        };

        const resets: Allowance = {
          ...base,
          resets: base.resets === "month" ? "annual" : "month",
        };

        const resetEvery: Allowance = {
          ...base,
          resetEvery: (base.resetEvery ?? 1) === 1 ? 2 : 1,
        };

        const pricing: Allowance =
          base.pricing === undefined
            ? { ...base, pricing: unitPricing(3) }
            : (({ pricing: _pricing, ...rest }) => rest)(base);

        return [kind, overage, resets, resetEvery, pricing].every(
          (variant) => !sameSpendShape(base, variant),
        );
      },
      { runs: 80, size: 30 },
    ),
  );

  it.effect("ignores the count, cap and pool that a merge replaces", () =>
    assertProperty(
      Arbitrary.schema(AllowanceSpec),
      (spec) => {
        const base = buildAllowance(spec);

        const included: Allowance = {
          ...base,
          included: base.included === "unlimited" ? 1 : "unlimited",
          pooled: base.pooled === true ? false : true,
        };

        const cap: Allowance =
          base.cap === undefined ? { ...base, cap: 7 } : (({ cap: _cap, ...rest }) => rest)(base);

        return sameSpendShape(base, included) && sameSpendShape(base, cap);
      },
      { runs: 70, size: 25 },
    ),
  );
});

const ScheduleEditSpec = Schema.Struct({
  schedule: ScheduleSpec,
  planId: Schema.Literals(["e0", "e1", "e2", "e3", "e4", "next"]),
  group: Schema.Literals(["default", "g1", "g2", "extra"]),
  at: TimeIndex,
});

describe("the plan schedule", () => {
  it.effect("withPhase sorts by instant and replaces the phase for that plan", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          schedule: ScheduleSpec,
          incoming: PhaseSpec,
        }),
      ),
      ({ schedule: specs, incoming }) => {
        const schedule = specs.map(buildPhase);
        const phase = buildPhase(incoming);
        const result = withPhase(schedule, phase);
        const kept = schedule.filter((candidate) => candidate.planId !== phase.planId);

        if (result.length !== kept.length + 1) return false;

        if (!kept.every((candidate) => result.includes(candidate))) return false;

        const replacements = result.filter((candidate) => candidate.planId === phase.planId);

        if (replacements.length !== 1 || replacements[0] !== phase) return false;

        for (let index = 1; index < result.length; index++) {
          if (result[index - 1]!.at.epochMilliseconds > result[index]!.at.epochMilliseconds)
            return false;
        }

        // Nothing but a phase for the same plan was dropped.
        return result.every(
          (candidate) => candidate.planId === phase.planId || schedule.includes(candidate),
        );
      },
      { runs: 80, size: 30 },
    ),
  );

  it.effect("removes named phases and reads the due and next phases by instant", () =>
    assertProperty(
      Arbitrary.schema(ScheduleEditSpec),
      ({ schedule: specs, planId, group, at }) => {
        const schedule = specs.map(buildPhase);

        const without = withoutPhase(schedule, planId);

        if (
          !same(
            without,
            schedule.filter((phase) => phase.planId !== planId),
          )
        )
          return false;

        const inGroup = phasesOfGroup(schedule, group);

        if (
          !same(
            inGroup,
            schedule.filter((phase) => phase.group === group),
          )
        )
          return false;

        const withoutGrouped = withoutGroupPhases(schedule, group);

        if (
          !same(
            withoutGrouped,
            schedule.filter((phase) => phase.group !== group),
          )
        )
          return false;

        for (const phase of schedule) {
          // An add-on phase names its group too, so it leaves with the group.
          if (withoutGrouped.includes(phase) !== (phase.group !== group)) return false;
        }

        const atMs = DateTime.toEpochMillis(INSTANTS[at]!);
        const due = duePhases(schedule, atMs);
        const expectedDue = schedule.filter((phase) => phase.at.epochMilliseconds <= atMs);

        if (due.length !== expectedDue.length) return false;

        if (!due.every((phase) => expectedDue.includes(phase))) return false;

        if (!expectedDue.every((phase) => due.includes(phase))) return false;

        if (!due.every((phase) => phase.at.epochMilliseconds <= atMs)) return false;

        for (let index = 1; index < due.length; index++) {
          if (due[index - 1]!.at.epochMilliseconds > due[index]!.at.epochMilliseconds) return false;
        }

        const next = nextPhase(schedule, atMs);
        const future = schedule.filter((phase) => phase.at.epochMilliseconds > atMs);

        if (future.length === 0) return next === undefined;

        if (next === undefined || !future.includes(next)) return false;

        const earliest = Math.min(...future.map((phase) => phase.at.epochMilliseconds));

        return next.at.epochMilliseconds === earliest;
      },
      { runs: 80, size: 30 },
    ),
  );

  it("treats a missing schedule as empty", () => {
    const phase = planPhase("next", INSTANTS[0]!, { group: DEFAULT_PLAN_GROUP });

    expect(withPhase(undefined, phase)).toEqual([phase]);
    expect(withoutPhase(undefined, "next")).toEqual([]);
    expect(withoutGroupPhases(undefined, DEFAULT_PLAN_GROUP)).toEqual([]);
    expect(phasesOfGroup(undefined, DEFAULT_PLAN_GROUP)).toEqual([]);
    expect(duePhases(undefined, DateTime.toEpochMillis(INSTANTS[0]!))).toEqual([]);
    expect(nextPhase(undefined, DateTime.toEpochMillis(INSTANTS[0]!))).toBeUndefined();
  });
});
