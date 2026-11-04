import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { allowancesOf } from "../../src/Catalog.ts";
import { ReleaseUsage } from "../../src/Subscription/ReleaseUsage.command.ts";
import { ReserveUsage } from "../../src/Subscription/ReserveUsage.command.ts";
import { SettleUsage } from "../../src/Subscription/SettleUsage.command.ts";
import {
  initialSubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import {
  Amount,
  commandOf,
  decideAt,
  DedupeKey,
  evolveAt,
  isAccepted,
  start,
  testCatalog,
} from "./Arbitraries.ts";

const Step = Schema.Union([
  Schema.TaggedStruct("Reserve", { amount: Amount, dedupeKey: DedupeKey }),
  Schema.TaggedStruct("Settle", { amount: Amount }),
  Schema.TaggedStruct("Release", { amount: Amount }),
]);

const ReservationScript = Schema.Struct({
  tier: Schema.Literals(["free", "unlimited"]),
  steps: Schema.Array(Step).pipe(Schema.check(Schema.isMaxLength(60))),
});

const activated = (tier: "free" | "unlimited"): SubscribedState => {
  const decision = decideAt(
    initialSubscriptionState,
    commandOf({ _tag: "Subscribe", tier }, initialSubscriptionState, start),
    start,
    "subscribe",
  );
  if (!isAccepted(decision)) throw new Error(`the catalog could not activate ${tier}`);
  const state = evolveAt(initialSubscriptionState, decision, start, "subscribe");
  if (state._tag !== "Subscribed") throw new Error("Subscribe did not activate a standing");
  expect(state.allowances).toEqual(allowancesOf(testCatalog, tier));
  return state;
};

type Step = typeof Step.Type;

const commandFor = (step: Step) => {
  switch (step._tag) {
    case "Reserve":
      return new ReserveUsage({
        feature: "messages",
        amount: step.amount,
        ...(step.dedupeKey === undefined ? {} : { dedupeKey: step.dedupeKey }),
      });
    case "Settle":
      return new SettleUsage({ feature: "messages", amount: step.amount });
    case "Release":
      return new ReleaseUsage({ feature: "messages", amount: step.amount });
  }
};

describe("reservation", () => {
  it.effect("settle plus release never exceeds what was held, and a hold bills once", () =>
    assertProperty(
      Arbitrary.schema(ReservationScript),
      (script) => {
        const unlimited = script.tier === "unlimited";
        let state = activated(script.tier);
        const included = state.allowances.messages?.included;
        if (included === undefined) return false;

        let held = state.reserved.messages ?? 0;
        let used = state.usage.messages ?? 0;
        let remaining = state.remaining.messages;
        let reservedTotal = 0;
        let settled = 0;
        let released = 0;

        for (const step of script.steps) {
          const decision = decideAt(state, commandFor(step), start, "reserve");
          if (!isAccepted(decision)) {
            // A hold is refused only when it would spend more than is left;
            // a settle or release is refused only when it is more than held.
            const expected = step._tag === "Reserve" ? "ReservationExceeded" : "NoReservation";
            if (decision._tag !== expected) return false;
            if (step._tag === "Reserve" && unlimited) return false;
            continue;
          }
          // A deduped reserve records nothing.
          if (decision.length === 0) continue;

          if (step._tag === "Reserve") {
            const event = decision[0] as unknown as {
              readonly reservedAfter: number;
              readonly remainingAfter: number | null;
            };
            if (event.reservedAfter !== held + step.amount) return false;
            if (event.remainingAfter !== (remaining === null ? null : remaining - step.amount)) {
              return false;
            }
            held = event.reservedAfter;
            remaining = event.remainingAfter;
            reservedTotal += step.amount;
          } else if (step._tag === "Settle") {
            const recorded = decision[0] as unknown as {
              readonly usedAfter: number;
              readonly remainingAfter: number | null;
            };
            const settledEvent = decision[1] as unknown as { readonly reservedAfter: number };
            if (recorded.usedAfter !== used + step.amount) return false;
            if (recorded.remainingAfter !== remaining) return false;
            if (settledEvent.reservedAfter !== held - step.amount) return false;
            used = recorded.usedAfter;
            held = settledEvent.reservedAfter;
            settled += step.amount;
          } else {
            const event = decision[0] as unknown as {
              readonly reservedAfter: number;
              readonly remainingAfter: number | null;
            };
            if (event.reservedAfter !== held - step.amount) return false;
            if (event.remainingAfter !== (remaining === null ? null : remaining + step.amount)) {
              return false;
            }
            held = event.reservedAfter;
            remaining = event.remainingAfter;
            released += step.amount;
          }

          state = evolveAt(state, decision, start, "reserve") as SubscribedState;
          if (held < 0 || used < 0) return false;
          if (settled + released > reservedTotal) return false;
          if (settled !== used) return false;
          if (
            !unlimited &&
            included !== "unlimited" &&
            used + held + (remaining ?? 0) !== included
          ) {
            return false;
          }
          if (unlimited && remaining !== null) return false;
        }

        return true;
      },
      { runs: 80, size: 40 },
    ),
  );

  it.effect("a settled reservation leaves usage at exactly what was held", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          held: Amount,
          settled: Amount,
          released: Amount,
        }),
      ),
      (input) => {
        let state = activated("free");
        const reserve = decideAt(
          state,
          new ReserveUsage({ feature: "messages", amount: input.held }),
          start,
          "hold",
        );
        if (!isAccepted(reserve)) return reserve._tag === "ReservationExceeded";
        state = evolveAt(state, reserve, start, "hold") as SubscribedState;

        const settle = decideAt(
          state,
          new SettleUsage({ feature: "messages", amount: input.settled }),
          start,
          "settle",
        );

        // Settling more than is held is a typed refusal, never a silently
        // shrinking allowance.
        if (!isAccepted(settle)) {
          return input.settled > input.held && settle._tag === "NoReservation";
        }
        const afterSettle = evolveAt(state, settle, start, "settle") as SubscribedState;

        const release = decideAt(
          afterSettle,
          new ReleaseUsage({ feature: "messages", amount: input.released }),
          start,
          "release",
        );
        if (!isAccepted(release)) {
          return input.released > input.held - input.settled && release._tag === "NoReservation";
        }
        const afterRelease = evolveAt(afterSettle, release, start, "release") as SubscribedState;
        if (afterRelease._tag !== "Subscribed") return false;
        return (afterRelease.usage.messages ?? 0) === input.settled;
      },
      { runs: 80, size: 20 },
    ),
  );
});
