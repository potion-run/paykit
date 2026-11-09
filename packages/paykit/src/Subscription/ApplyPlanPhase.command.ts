import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { PlanChanged } from "./ChangeTier.command.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * Apply the plan phase that starts at `at`. The normal path is the phase's own
 * deadline: the scheduler fires this command at the instant the phase named,
 * and the boundary close only handles phases that were already overdue
 * (ADR 0039 §3).
 *
 * A fire that no longer matches a pending phase records nothing, the way a
 * stale `RetryTopUp` does: a withdrawal, a later move in the same group, a
 * cancellation or a previous apply all remove or replace the phase it named.
 */
export class ApplyPlanPhase extends Domain.Command("ApplyPlanPhase", {
  target: AccountId,
  input: {
    /** The plan the phase names. */
    planId: Schema.String,
    /** The instant the phase starts; a stale instant records nothing. */
    at: Schema.DateTimeUtc,
  },
  events: [PlanChanged],
  rejects: [],
}) {}
