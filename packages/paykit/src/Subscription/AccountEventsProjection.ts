import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { AccountEvents } from "./AccountEvents.stream.ts";
import { Subscription } from "./Subscription.aggregate.ts";

/** Appends every subscription event to the account's audit stream. */
export class AccountEventsProjection extends Domain.Projection("AccountEventsProjection", {
  from: [Subscription],
  key: Subscription,
  on: Subscription.definition.events,
  writes: [AccountEvents],
}) {}

export const AccountEventsLive = AccountEventsProjection.toLayer(
  Effect.gen(function* () {
    const stream = yield* AccountEvents;
    return Effect.fn("Paykit.AccountEvents.project")(function* (batch) {
      for (const input of batch) {
        yield* stream.append(input, input.event);
      }
    });
  }),
);
