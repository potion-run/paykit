import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * A plan phase was scheduled for an instant that is not in the future. A
 * schedule states what will happen, so a phase at or before `now` is a move
 * that should have been an `attach` — and one the boundary would apply the
 * moment it was recorded.
 */
export class PlanPhaseNotFuture extends Domain.Rejection("PlanPhaseNotFuture", {
  /** The plan the phase would have moved to. */
  tier: Schema.String,
  /** The instant the caller asked for. */
  at: Schema.DateTimeUtc,
  /** The account's clock when the schedule was decided. */
  now: Schema.DateTimeUtc,
}) {}
