import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { GraceEntered } from "./EnterGrace.command.ts";
import { GraceElapsed } from "./GraceElapsed.command.ts";
import { PaymentFailed } from "./RecordPaymentFailure.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";

/**
 * Whenever an account enters grace, schedule the deadline that expires it.
 * A recovery before then leaves the deadline to fire as a no-op.
 */
export class Dunning extends Domain.Policy("Dunning", {
  from: Subscription,
  on: [PaymentFailed, GraceEntered],
}) {}

export const DunningLive = Dunning.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;
    return Effect.fn("Paykit.Dunning.react")(function* ({ key, event }) {
      const graceUntil = event._tag === "PaymentFailed" ? event.graceUntilAfter : event.graceUntil;
      yield* subscriptions
        .schedule(key, new GraceElapsed({}), {
          at: graceUntil,
          commandId: `grace-elapsed:${graceUntil.epochMilliseconds}`,
        })
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
    });
  }),
);
