import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { asSystem } from "./Auth/Actor.ts";
import { Entitlements } from "./Subscription/Entitlements.view.ts";
import { Hold as HoldCommand } from "./Subscription/Hold.command.ts";
import { ReleaseHold } from "./Subscription/ReleaseHold.command.ts";
import { UsageReleased } from "./Subscription/ReleaseHold.command.ts";
import { SettleHold, UsageSettled } from "./Subscription/SettleHold.command.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";

/** What to hold: the units, the dimension that prices them, and the retry key. */
export interface HoldInput {
  readonly account: string;
  readonly feature: string;
  readonly amount: number;
  /** Which rate prices the units, for a credit-priced feature. */
  readonly dimension?: string;
  /** The id of the hold. Defaults to a new one; pass a retry key to reuse it. */
  readonly holdId?: string;
  /** How long the hold lives. Defaults to fifteen minutes. */
  readonly expiresAt?: Date;
  readonly dedupeKey?: string;
}

/** What a hold answers: its id, and what the feature has left. */
export interface HoldResult {
  readonly holdId: string;
  readonly remaining: number | null;
}

/** Settle a hold, billing `amount` of it and returning the rest. */
export interface SettleInput {
  readonly account: string;
  readonly holdId: string;
  /** Units to bill. Omitted bills the whole hold. */
  readonly amount?: number;
  readonly dedupeKey?: string;
}

/** What a settle did: what it billed, and what it returned. */
export interface SettleResult {
  readonly billed: number;
  readonly released: number;
}

/** Return a hold without billing any of it. */
export interface ReleaseInput {
  readonly account: string;
  readonly holdId: string;
}

/** What a release did: how many units went back. */
export interface ReleaseResult {
  readonly released: number;
}

const deduped = (dedupeKey: string | undefined) =>
  dedupeKey === undefined ? undefined : { commandId: dedupeKey };

/**
 * Hold capacity for work that has not finished: an agent turn, a long job, a
 * request whose cost is known up front. The hold has an id, so the caller
 * settles exactly that hold — not whatever else is open on the feature — and
 * `Settle` bills what the work used in one call, returning the rest.
 *
 * A hold past a blocking allowance, or past the pool on a credit-priced
 * feature, is refused in the same transaction. `dedupeKey` is also the command
 * id, so a retry holds once.
 *
 * ### Holding, then settling what ran
 * **Example:** Hold the cost of a turn, bill only what it used
 * ```typescript
 * const { holdId } = yield* Hold({ account, feature: "ai", amount: 1_000, dimension: "gpt-large" });
 *
 * const used = yield* runTheTurn();
 * // One call: bill what ran, return the rest.
 * yield* Settle({ account, holdId, amount: used });
 * ```
 *
 * @primitive
 */
export const Hold = Effect.fn("Paykit.Hold")(function* () {
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  return Effect.fn("Paykit.Hold.place")(function* (
    input: HoldInput,
  ): Effect.fn.Return<HoldResult, unknown> {
    const holdId = input.holdId ?? (yield* Effect.sync(() => crypto.randomUUID()));
    const ref = Subscription.ref(input.account);
    const receipt = yield* asSystem(
      subscription.send(
        ref,
        new HoldCommand({
          holdId,
          feature: input.feature,
          amount: input.amount,
          ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
          ...(input.expiresAt === undefined
            ? {}
            : { expiresAt: input.expiresAt.toISOString() as never }),
          ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
        }),
        deduped(input.dedupeKey),
      ),
    );
    const view = Option.getOrNull(yield* entitlements.query(ref, { atLeast: receipt }));
    const remaining = view?.features[input.feature]?.remaining ?? null;
    return { holdId, remaining };
  });
});

/**
 * Turn a hold into usage: bill `amount` of it and return whatever is left, in
 * the same command. Settling the whole hold is `Settle({ account, holdId })`.
 *
 * A hold that is already settled records nothing, so a retry bills once; a
 * released or expired hold is a typed refusal.
 *
 * @primitive
 */
export const Settle = Effect.fn("Paykit.Settle")(function* () {
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  return Effect.fn("Paykit.Settle.hold")(function* (
    input: SettleInput,
  ): Effect.fn.Return<SettleResult, unknown> {
    const ref = Subscription.ref(input.account);
    const receipt = yield* asSystem(
      subscription.send(
        ref,
        new SettleHold({
          holdId: input.holdId,
          ...(input.amount === undefined ? {} : { amount: input.amount }),
          ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
        }),
        input.dedupeKey === undefined
          ? { commandId: `settle:${input.holdId}` }
          : deduped(input.dedupeKey),
      ),
    );
    yield* entitlements.query(ref, { atLeast: receipt });
    const settled = receipt.events.find(
      (event): event is UsageSettled => (event as { _tag?: string })._tag === "UsageSettled",
    );
    return {
      billed: settled?.amount ?? 0,
      released: settled?.released ?? 0,
    };
  });
});

/**
 * Return a hold without billing it: the work failed, was cancelled, or never
 * ran. Releasing after `expiresAt` still returns the units, because a late
 * release is a cleanup and not a charge.
 *
 * @primitive
 */
export const Release = Effect.fn("Paykit.Release")(function* () {
  const subscription = yield* Subscription;
  const entitlements = yield* Entitlements;
  return Effect.fn("Paykit.Release.hold")(function* (
    input: ReleaseInput,
  ): Effect.fn.Return<ReleaseResult, unknown> {
    const ref = Subscription.ref(input.account);
    const receipt = yield* asSystem(
      subscription.send(ref, new ReleaseHold({ holdId: input.holdId }), {
        commandId: `release:${input.holdId}`,
      }),
    );
    yield* entitlements.query(ref, { atLeast: receipt });
    const released = receipt.events.find(
      (event): event is UsageReleased => (event as { _tag?: string })._tag === "UsageReleased",
    );
    return { released: released?.amount ?? 0 };
  });
});
