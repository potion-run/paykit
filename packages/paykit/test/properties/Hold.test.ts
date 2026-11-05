import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Hold, HoldExceeded } from "../../src/Subscription/Hold.command.ts";
import { HoldElapsed } from "../../src/Subscription/HoldElapsed.command.ts";
import { ReleaseHold } from "../../src/Subscription/ReleaseHold.command.ts";
import { SettleHold } from "../../src/Subscription/SettleHold.command.ts";
import {
  holdOf,
  initialSubscriptionState,
  reservedOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import {
  Amount,
  commandOf,
  DedupeKey,
  decideAt,
  evolveAt,
  HoldId,
  isAccepted,
  start,
} from "./Arbitraries.ts";

const Step = Schema.Union([
  Schema.TaggedStruct("Hold", { holdId: HoldId, amount: Amount, dedupeKey: DedupeKey }),
  Schema.TaggedStruct("Settle", { holdId: HoldId, amount: Schema.optionalKey(Amount) }),
  Schema.TaggedStruct("Release", { holdId: HoldId }),
]);
type Step = typeof Step.Type;

const HoldScript = Schema.Struct({
  tier: Schema.Literals(["free", "unlimited"]),
  steps: Schema.Array(Step).pipe(Schema.check(Schema.isMaxLength(60))),
});

const opened = (tier: "free" | "unlimited"): SubscribedState => {
  const decision = decideAt(
    initialSubscriptionState,
    commandOf({ _tag: "Subscribe", tier }, initialSubscriptionState, start),
    start,
    "open",
  );
  if (!isAccepted(decision)) throw new Error("the fixture catalog could not open a standing");
  const state = evolveAt(initialSubscriptionState, decision, start, "open");
  if (state._tag !== "Subscribed") throw new Error("opening did not activate a standing");
  return state;
};

const commandFor = (step: Step) => {
  switch (step._tag) {
    case "Hold":
      return new Hold({
        holdId: step.holdId,
        feature: "messages",
        amount: step.amount,
        expiresAt: DateTime.add(start, { days: 365 }),
        ...(step.dedupeKey === undefined ? {} : { dedupeKey: step.dedupeKey }),
      });
    case "Settle":
      return new SettleHold({
        holdId: step.holdId,
        ...(step.amount === undefined ? {} : { amount: step.amount }),
      });
    case "Release":
      return new ReleaseHold({ holdId: step.holdId });
  }
};

const openAmountOf = (state: SubscribedState): number =>
  Object.values(state.holds)
    .filter((hold) => hold.status === "open" && hold.feature === "messages")
    .reduce((sum, hold) => sum + hold.amount, 0);

describe("holds", () => {
  it.effect("a hold is addressable, settles once, and returns what it did not bill", () =>
    assertProperty(
      Arbitrary.schema(HoldScript),
      (script) => {
        const unlimited = script.tier === "unlimited";
        let state = opened(script.tier);

        for (const [index, step] of script.steps.entries()) {
          const before = state;
          const decision = decideAt(state, commandFor(step), start, `step-${index}`);

          if (!isAccepted(decision)) {
            if (step._tag === "Hold") {
              if (decision._tag !== "HoldExceeded") return false;
              const rejection = decision as HoldExceeded;
              if (unlimited) return false;
              if (rejection.requested !== step.amount) return false;
              return rejection.remaining === (before.remaining.messages ?? 0);
            }
            const hold = holdOf(before, step.holdId);
            if (step._tag === "Settle") {
              if (hold === null) return decision._tag === "HoldUnknown";
              if (hold.status === "released") return decision._tag === "HoldSettled";
              if (step.amount !== undefined && step.amount > hold.amount) {
                return decision._tag === "HoldExceeded";
              }
              return false;
            }
            if (hold === null) return decision._tag === "HoldUnknown";
            return hold.status === "settled" && decision._tag === "HoldSettled";
          }

          if (decision.length === 0) {
            // Only these three retries record nothing.
            if (step._tag === "Hold") {
              return (
                holdOf(before, step.holdId) !== null ||
                (step.dedupeKey !== undefined && before.dedupeKeys[step.dedupeKey] === true)
              );
            }
            if (step._tag === "Settle") {
              return holdOf(before, step.holdId)?.status === "settled";
            }
            return holdOf(before, step.holdId)?.status === "released";
          }

          const evolved = evolveAt(state, decision, start, `step-${index}`);
          if (evolved._tag !== "Subscribed") return false;
          const after = evolved;

          switch (step._tag) {
            case "Hold": {
              const event = decision[0] as unknown as {
                readonly holdId: string;
                readonly amount: number;
                readonly cost: number;
                readonly rate: number;
                readonly remainingAfter: number | null;
              };
              const held = after.holds[step.holdId];
              if (event.holdId !== step.holdId || event.amount !== step.amount) return false;
              if (event.cost !== 0 || event.rate !== 0) return false;
              if (held === undefined || held.status !== "open" || held.amount !== step.amount) {
                return false;
              }
              const expectedRemaining =
                before.remaining.messages === null ? null : before.remaining.messages - step.amount;
              if (event.remainingAfter !== expectedRemaining) return false;
              if (after.remaining.messages !== event.remainingAfter) return false;
              if (after.usage.messages !== before.usage.messages) return false;
              if (after.credits !== before.credits) return false;
              break;
            }
            case "Settle": {
              const held = holdOf(before, step.holdId)!;
              const billed = step.amount ?? held.amount;
              const released = held.amount - billed;
              const recorded = decision[0] as unknown as {
                readonly amount: number;
                readonly usedAfter: number;
                readonly remainingAfter: number | null;
              };
              const settled = decision[1] as unknown as {
                readonly holdId: string;
                readonly amount: number;
                readonly released: number;
                readonly cost: number;
                readonly remainingAfter: number | null;
              };
              if (recorded.amount !== billed) return false;
              if (recorded.usedAfter !== (before.usage.messages ?? 0) + billed) return false;
              if (settled.holdId !== step.holdId) return false;
              if (settled.amount !== billed || settled.released !== released) return false;
              if (settled.cost !== 0) return false;
              const expectedRemaining =
                before.remaining.messages === null ? null : before.remaining.messages + released;
              if (settled.remainingAfter !== expectedRemaining) return false;
              const closed = after.holds[step.holdId];
              if (closed === undefined || closed.status !== "settled") return false;
              if (after.usage.messages !== recorded.usedAfter) return false;
              if (after.remaining.messages !== settled.remainingAfter) return false;
              if (after.credits !== before.credits) return false;
              if (reservedOf(after, "messages") !== reservedOf(before, "messages") - held.amount) {
                return false;
              }
              break;
            }
            case "Release": {
              const held = holdOf(before, step.holdId)!;
              const event = decision[0] as unknown as {
                readonly holdId: string;
                readonly amount: number;
                readonly cost: number;
                readonly remainingAfter: number | null;
              };
              if (event.holdId !== step.holdId) return false;
              if (event.amount !== held.amount || event.cost !== 0) return false;
              const expectedRemaining =
                before.remaining.messages === null ? null : before.remaining.messages + held.amount;
              if (event.remainingAfter !== expectedRemaining) return false;
              const closed = after.holds[step.holdId];
              if (closed === undefined || closed.status !== "released") return false;
              if (after.usage.messages !== before.usage.messages) return false;
              if (after.remaining.messages !== event.remainingAfter) return false;
              if (after.credits !== before.credits) return false;
              if (reservedOf(after, "messages") !== reservedOf(before, "messages") - held.amount) {
                return false;
              }
              break;
            }
          }

          // The open holds are the reserve; no counter can drift from them.
          if (reservedOf(after, "messages") !== openAmountOf(after)) return false;
          if (unlimited) {
            if (after.remaining.messages !== null) return false;
          } else if (
            (after.usage.messages ?? 0) +
              reservedOf(after, "messages") +
              (after.remaining.messages ?? 0) !==
            100
          ) {
            return false;
          }

          state = after;
        }

        return true;
      },
      { runs: 100, size: 40 },
    ),
  );

  it.effect("one hold's settle does not close another", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          first: Amount,
          second: Amount,
          settled: Amount,
        }),
      ),
      (input) => {
        let state = opened("free");
        const first = decideAt(
          state,
          new Hold({
            holdId: "hold-a",
            feature: "messages",
            amount: input.first,
            expiresAt: DateTime.add(start, { days: 365 }),
          }),
          start,
          "hold-a",
        );
        if (!isAccepted(first)) return first._tag === "HoldExceeded";
        state = evolveAt(state, first, start, "hold-a") as SubscribedState;

        const second = decideAt(
          state,
          new Hold({
            holdId: "hold-b",
            feature: "messages",
            amount: input.second,
            expiresAt: DateTime.add(start, { days: 365 }),
          }),
          start,
          "hold-b",
        );
        if (!isAccepted(second)) return second._tag === "HoldExceeded";
        state = evolveAt(state, second, start, "hold-b") as SubscribedState;
        if (input.settled > input.first) {
          const tooMuch = decideAt(
            state,
            new SettleHold({ holdId: "hold-a", amount: input.settled }),
            start,
            "settle-over",
          );
          return !isAccepted(tooMuch) && tooMuch._tag === "HoldExceeded";
        }

        const settle = decideAt(
          state,
          new SettleHold({ holdId: "hold-a", amount: input.settled }),
          start,
          "settle-a",
        );
        if (!isAccepted(settle) || settle.length === 0) return false;
        state = evolveAt(state, settle, start, "settle-a") as SubscribedState;
        return (
          holdOf(state, "hold-a")?.status === "settled" &&
          holdOf(state, "hold-b")?.status === "open" &&
          reservedOf(state, "messages") === input.second
        );
      },
      { runs: 80, size: 20 },
    ),
  );

  it("the sweep releases only a hold that is still open past its deadline", () => {
    let state = opened("free");
    const expiresAt = DateTime.add(start, { minutes: 15 });
    const placed = decideAt(
      state,
      new Hold({ holdId: "hold-expiring", feature: "messages", amount: 10, expiresAt }),
      start,
      "hold-expiring",
    );
    if (!isAccepted(placed)) throw new Error("the fixture allowance refused the hold");
    state = evolveAt(state, placed, start, "hold-expiring") as SubscribedState;

    // Firing before the deadline leaves the hold alone.
    const early = decideAt(
      state,
      new HoldElapsed({ holdId: "hold-expiring" }),
      DateTime.add(start, { minutes: 14 }),
      "sweep-early",
    );
    expect(isAccepted(early) && early.length).toBe(0);

    // A settle in the window before the policy runs still refuses, because the
    // deadline is already past.
    const late = decideAt(
      state,
      new SettleHold({ holdId: "hold-expiring" }),
      expiresAt,
      "settle-late",
    );
    expect(!isAccepted(late) && late._tag).toBe("HoldExpired");

    // The sweep records the same cleanup a caller's release would.
    const swept = decideAt(state, new HoldElapsed({ holdId: "hold-expiring" }), expiresAt, "sweep");
    if (!isAccepted(swept)) throw new Error("the sweep refused an open expired hold");
    expect(swept.map((event) => event._tag)).toEqual(["UsageReleased"]);
    expect((swept[0] as unknown as { readonly remainingAfter: number }).remainingAfter).toBe(100);
    const released = evolveAt(state, swept, expiresAt, "sweep") as SubscribedState;
    expect(holdOf(released, "hold-expiring")?.status).toBe("released");

    // Once the units are back, a settle is a billed-hold refusal and a second
    // sweep is a replay.
    const settledAfter = decideAt(
      released,
      new SettleHold({ holdId: "hold-expiring" }),
      expiresAt,
      "settle-after",
    );
    expect(!isAccepted(settledAfter) && settledAfter._tag).toBe("HoldSettled");
    const again = decideAt(
      released,
      new HoldElapsed({ holdId: "hold-expiring" }),
      expiresAt,
      "sweep-again",
    );
    expect(isAccepted(again) && again.length).toBe(0);
  });

  it.effect("the sweep releases an open hold exactly once, past its deadline", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
          elapsedMinutes: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
          ),
          before: Schema.Literals(["none", "settle", "release"]),
        }),
      ),
      ({ amount, elapsedMinutes, before }) => {
        let state = opened("free");
        const expiresAt = DateTime.add(start, { minutes: 15 });
        const placed = decideAt(
          state,
          new Hold({
            holdId: "hold-swept",
            feature: "messages",
            amount,
            expiresAt,
          }),
          start,
          "place-swept",
        );
        if (!isAccepted(placed)) return false;
        state = evolveAt(state, placed, start, "place-swept") as SubscribedState;

        // A caller may settle or release before the policy runs; both close
        // the hold, and the sweep must then record nothing.
        if (before !== "none") {
          const command =
            before === "settle"
              ? new SettleHold({ holdId: "hold-swept" })
              : new ReleaseHold({ holdId: "hold-swept" });
          const decision = decideAt(state, command, start, before);
          if (!isAccepted(decision)) return false;
          state = evolveAt(state, decision, start, before) as SubscribedState;
          if (reservedOf(state, "messages") !== 0) return false;
        }

        const at = DateTime.add(start, { minutes: elapsedMinutes });
        const sweep = decideAt(state, new HoldElapsed({ holdId: "hold-swept" }), at, "sweep");

        // A closed hold and a deadline that has not arrived record nothing.
        if (before !== "none" || elapsedMinutes < 15) {
          return isAccepted(sweep) && sweep.length === 0;
        }

        if (!isAccepted(sweep) || sweep.length !== 1) return false;
        if (sweep[0]?._tag !== "UsageReleased") return false;
        const released = evolveAt(state, sweep, at, "sweep") as SubscribedState;
        if (released.holds["hold-swept"]?.status !== "released") return false;
        if (reservedOf(released, "messages") !== 0) return false;
        // The units return to the allowance; a sweep is a cleanup, not a charge.
        if (released.remaining.messages !== 100) return false;
        if ((released.usage.messages ?? 0) !== 0) return false;

        // A second deadline for the same hold is a replay.
        const again = decideAt(released, new HoldElapsed({ holdId: "hold-swept" }), at, "again");
        return isAccepted(again) && again.length === 0;
      },
      { runs: 80, size: 20 },
    ),
  );
});
