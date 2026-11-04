import * as Effect from "effect/Effect";
import { asSystem } from "./Auth/Actor.ts";
import { Entitlements } from "./Subscription/Entitlements.view.ts";
import { ReleaseUsage } from "./Subscription/ReleaseUsage.command.ts";
import { ReserveUsage } from "./Subscription/ReserveUsage.command.ts";
import { SettleUsage } from "./Subscription/SettleUsage.command.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";

/** One reservation: what to hold, and the key a retry dedupes on. */
export interface ReserveInput {
  readonly account: string;
  readonly feature: string;
  readonly amount: number;
  readonly dedupeKey?: string;
}

/** What a reservation or a release names. */
export interface ReleaseInput {
  readonly account: string;
  readonly feature: string;
  readonly amount: number;
}

const deduped = (dedupeKey: string | undefined) =>
  dedupeKey === undefined ? undefined : { commandId: dedupeKey };

/**
 * Hold allowance for work that has not finished: an agent turn, a long job, a
 * request whose cost is known up front. A hold takes units out of `remaining`
 * but records no usage, so a second caller cannot spend them, and no invoice
 * bills them until `Settle` confirms.
 *
 * A hold past a blocking allowance is refused in the same transaction, exactly
 * like `Track`. `dedupeKey` is also the command id, so a retry holds once.
 *
 * Waits for the `Entitlements` read model, so a `Check` straight after a
 * `Reserve` sees the reduced remaining.
 *
 * ### Reserving, then settling
 * **Example:** Hold the cost of a turn, bill only what it used
 * ```typescript
 * yield* Reserve({ account, feature: "messages", amount: 10, dedupeKey: turnId });
 * const used = yield* runTheTurn();
 * yield* Release({ account, feature: "messages", amount: 10 - used });
 * yield* Settle({ account, feature: "messages", amount: used });
 * ```
 *
 * @primitive
 */
export const Reserve = Effect.fn("Paykit.Reserve")(function* () {
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  return Effect.fn("Paykit.Reserve.hold")(function* (input: ReserveInput) {
    const receipt = yield* asSystem(
      subscription.send(
        Subscription.ref(input.account),
        new ReserveUsage({
          feature: input.feature,
          amount: input.amount,
          ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
        }),
        deduped(input.dedupeKey),
      ),
    );
    yield* entitlements.query(Subscription.ref(input.account), { atLeast: receipt });
    return receipt;
  });
});

/**
 * Turn a hold into usage. `remaining` does not move: the units left it when
 * they were held. Settling more than is held is refused, because the caller
 * that spent more than it reserved has to say so with a `Track`.
 *
 * @primitive
 */
export const Settle = Effect.fn("Paykit.Settle")(function* () {
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  return Effect.fn("Paykit.Settle.hold")(function* (input: ReserveInput) {
    const receipt = yield* asSystem(
      subscription.send(
        Subscription.ref(input.account),
        new SettleUsage({
          feature: input.feature,
          amount: input.amount,
          ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
        }),
        deduped(input.dedupeKey),
      ),
    );
    yield* entitlements.query(Subscription.ref(input.account), { atLeast: receipt });
    return receipt;
  });
});

/**
 * Return a hold without billing it: the work failed, was cancelled, or cost
 * less than it reserved. Releasing from an account that holds nothing is
 * refused, so a leaking reservation shows up as an error rather than a
 * silently shrinking allowance.
 *
 * @primitive
 */
export const Release = Effect.fn("Paykit.Release")(function* () {
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  return Effect.fn("Paykit.Release.hold")(function* (input: ReleaseInput) {
    const receipt = yield* asSystem(
      subscription.send(
        Subscription.ref(input.account),
        new ReleaseUsage({ feature: input.feature, amount: input.amount }),
      ),
    );
    yield* entitlements.query(Subscription.ref(input.account), { atLeast: receipt });
    return receipt;
  });
});
