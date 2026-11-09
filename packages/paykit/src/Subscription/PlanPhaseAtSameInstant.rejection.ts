import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * Two plan phases in one transaction start at the same instant. A schedule is
 * strictly ordered, so "at most one phase per instant" is the list's shape and
 * not a rule an apply re-checks (ADR 0039 §3).
 */
export class PlanPhaseAtSameInstant extends Domain.Rejection("PlanPhaseAtSameInstant", {
  /** The plan the second phase named. */
  tier: Schema.String,
  /** The plan the first phase at that instant named. */
  occupying: Schema.String,
  /** The instant both phases named. */
  at: Schema.DateTimeUtc,
}) {}
