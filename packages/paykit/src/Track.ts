import * as Effect from "effect/Effect";
import { asSystem } from "./Auth/Actor.ts";
import { Entitlements } from "./Subscription/Entitlements.view.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import { TrackUsage } from "./Subscription/TrackUsage.command.ts";

/** One usage fact. `dedupeKey` makes a retry record once. */
export interface TrackInput {
  readonly account: string;
  readonly feature: string;
  readonly amount: number;
  readonly dedupeKey?: string;
}

/**
 * Record usage in the same transaction that checks the allowance. The
 * `dedupeKey` is also the command id, so a provider retry is a replay.
 * Waits for this write to reach the `Entitlements` read model so a `Check`
 * straight after a `Track` sees it.
 */
export const Track = Effect.fn("Paykit.Track")(function* () {
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  return Effect.fn("Paykit.Track.record")(function* (input: TrackInput) {
    const receipt = yield* asSystem(
      subscription.send(
        Subscription.ref(input.account),
        new TrackUsage({
          feature: input.feature,
          amount: input.amount,
          ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
        }),
        input.dedupeKey === undefined ? undefined : { commandId: input.dedupeKey },
      ),
    );
    yield* entitlements.query(Subscription.ref(input.account), { atLeast: receipt });
    return receipt;
  });
});
