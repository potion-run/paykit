import {
  Tier,
  TierCustomize,
  TierId,
  TierKind,
  Tier as TierSchema,
  tier,
  type TierInput,
} from "./Tier.ts";

/**
 * A purchasable plan. `Tier` is the internal schema name while the aggregate
 * still records `TierChanged`; the public word is `Plan`.
 */
export const Plan = TierSchema;

export type Plan = typeof Plan.Type;

export type PlanInput = TierInput;

export const PlanId = TierId;

export type PlanId = typeof PlanId.Type;

export const PlanKind = TierKind;

export type PlanKind = typeof PlanKind.Type;

export const PlanCustomize = TierCustomize;

export type PlanCustomize = typeof PlanCustomize.Type;

export { PlanTrial } from "./Tier.ts";

/** Declare a plan. The alias is the public spelling while commands migrate. */
export const plan = tier;

/** The internal schema, exported for the migration window. */
export { Tier };
