import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { ApplyPlanPhase } from "./ApplyPlanPhase.command.ts";
import { PlanChangeScheduled } from "./ScheduleTierChange.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";

/**
 * Whenever a plan phase is scheduled, schedule the command that applies it at
 * the phase's own instant. The deadline is keyed by the plan and the instant,
 * so a redelivered `PlanChangeScheduled` schedules one apply rather than two.
 *
 * The close still applies phases that were already overdue when it ran; this
 * policy is the normal path, and a deadline whose phase was withdrawn, moved
 * or cancelled fires as a no-op (ADR 0039 §3).
 */
export class PlanPhaseSchedule extends Domain.Policy("PlanPhaseSchedule", {
  from: Subscription,
  on: [PlanChangeScheduled],
}) {}

export const PlanPhaseScheduleLive = PlanPhaseSchedule.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;

    return Effect.fn("Paykit.PlanPhaseSchedule.react")(function* ({ key, event }) {
      yield* subscriptions
        .schedule(key, new ApplyPlanPhase({ planId: event.tier, at: event.at }), {
          at: event.at,
          commandId: `plan-phase:${event.tier}:${event.at.epochMilliseconds}`,
        })
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
    });
  }),
);
