import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { PeriodClosed } from "./ClosePeriod.command.ts";
import { TrialExtended } from "./ExtendTrial.command.ts";
import { PeriodEnded } from "./PeriodEnded.command.ts";
import { TrialStarted } from "./StartTrial.command.ts";
import { SubscriptionActivated } from "./Subscribe.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";

/**
 * Whenever a period opens, schedule its close. A closed period immediately
 * schedules the next one, so rollover is a chain rather than a cron.
 */
export class PeriodRollover extends Domain.Policy("PeriodRollover", {
  from: Subscription,
  on: [TrialStarted, SubscriptionActivated, TrialExtended, PeriodClosed],
}) {}

export const PeriodRolloverLive = PeriodRollover.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;
    return Effect.fn("Paykit.PeriodRollover.react")(function* ({ key, event }) {
      const periodEnd =
        event._tag === "PeriodClosed"
          ? event.nextPeriodEnd
          : event._tag === "TrialStarted" ||
              event._tag === "SubscriptionActivated" ||
              event._tag === "TrialExtended"
            ? event.periodEnd
            : undefined;
      if (periodEnd === undefined) return;
      yield* subscriptions
        .schedule(key, new PeriodEnded({ periodEnd }), {
          at: periodEnd,
          commandId: `period-ended:${periodEnd.epochMilliseconds}`,
        })
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
    });
  }),
);
