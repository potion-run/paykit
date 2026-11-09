import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * A move wants an older generation of the plan than the standing already holds.
 * The running deploy knows only the newer state, so recording the older terms
 * over it is the one direction a version may never take: the deploy is behind
 * the state it serves, and it must catch up before the account moves
 * (ADR 0047 §5).
 */
export class PlanVersionStale extends Domain.Rejection("PlanVersionStale", {
  /** The plan the move named. */
  tier: Schema.String,
  /** The generation the standing already holds. */
  current: Schema.Int,
  /** The generation the command would record. */
  requested: Schema.Int,
}) {}
