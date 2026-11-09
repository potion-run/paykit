import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * A plan phase named an add-on. A phase replaces a group's plan, and an add-on
 * replaces nothing: it stacks beside every group, so its start is the attach
 * that bought it, not a scheduled move (ADR 0039 §4).
 */
export class PlanPhaseNamesAddOn extends Domain.Rejection("PlanPhaseNamesAddOn", {
  /** The add-on the phase named. */
  tier: Schema.String,
}) {}
