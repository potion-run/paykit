import * as Schema from "effect/Schema";
import { Allowance, Allowances, allowance, type AllowanceInput } from "./Allowance.ts";

/**
 * One line of a plan: a feature, an included amount, a price, a reset, a
 * rollover and a proration. `Allowance` is the internal schema name while the
 * aggregate still records allowance-shaped events.
 */
export const PlanItem = Allowance;

export type PlanItem = typeof PlanItem.Type;

export type PlanItemInput = AllowanceInput;

export const PlanItems = Allowances;

export type PlanItems = typeof PlanItems.Type;

/** Declare one plan line. The alias is the public spelling. */
export const planItem = allowance;

/** The internal schema, exported for the migration window. */
export { Allowance };

/** A plan item's reset window, in the public shape. */
export const PlanItemReset = Schema.Struct({
  interval: Schema.String,
  count: Schema.Int,
});

export type PlanItemReset = typeof PlanItemReset.Type;

/** How a plan item prices a quantity change, in the public shape. */
export const PlanItemProration = Schema.Struct({
  onIncrease: Schema.Literals(["prorate_immediately", "prorate_next_cycle", "none"]),
  onDecrease: Schema.Literals(["prorate_immediately", "prorate_next_cycle", "none"]),
});

export type PlanItemProration = typeof PlanItemProration.Type;

/** A plan item's rollover, in the public shape. */
export const PlanItemRollover = Schema.Struct({
  max: Schema.Int,
  expiry: Schema.Literals(["forever", "period"]),
});

export type PlanItemRollover = typeof PlanItemRollover.Type;

/** The reset a plan item states, with the internal defaults applied. */
export const resetOf = (item: PlanItem): PlanItemReset => ({
  interval: item.resets,
  count: item.resetEvery ?? 1,
});

/** The public proration view of a plan item. */
export const prorationOf = (item: PlanItem): PlanItemProration => {
  const behaviour = item.prorate === "period_end" ? "prorate_next_cycle" : "prorate_immediately";

  return { onIncrease: behaviour, onDecrease: behaviour };
};

/** The rollover a plan item states, or `null` when it does not carry. */
export const rolloverOf = (item: PlanItem): PlanItemRollover | null =>
  item.carryOver === true
    ? {
        max: item.carryCap ?? (typeof item.included === "number" ? item.included : 0),
        expiry: "forever",
      }
    : null;
