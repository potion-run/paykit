import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * Two plan moves in one transaction name the same group. The second would have
 * to replace the first before either was recorded, so the operation would not
 * be one set of plans — it is refused as a whole (ADR 0039 §8).
 */
export class PlanGroupOccupied extends Domain.Rejection("PlanGroupOccupied", {
  /** The group the operation tried to fill twice. */
  group: Schema.String,
  /** The plan the second move named. */
  tier: Schema.String,
  /** The plan the first move in the same operation named. */
  occupying: Schema.String,
}) {}
