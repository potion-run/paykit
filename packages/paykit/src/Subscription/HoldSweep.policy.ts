import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { UsageReserved } from "./Hold.command.ts";
import { HoldElapsed } from "./HoldElapsed.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";

/**
 * Whenever a hold is placed, schedule the deadline that releases it. A hold
 * settled or released before then leaves the deadline to fire as a no-op, so a
 * caller that crashes between hold and settle does not keep capacity forever.
 */
export class HoldSweep extends Domain.Policy("HoldSweep", {
  from: Subscription,
  on: [UsageReserved],
}) {}

export const HoldSweepLive = HoldSweep.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;
    return Effect.fn("Paykit.HoldSweep.react")(function* ({ key, event }) {
      yield* subscriptions
        .schedule(key, new HoldElapsed({ holdId: event.holdId }), {
          at: event.expiresAt,
          // The hold's own id makes the deadline derivable, so a redelivered
          // `UsageReserved` schedules the same deadline once.
          commandId: `hold-elapsed:${event.holdId}`,
        })
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
    });
  }),
);
