import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { catalog } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { canClosePeriod, ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { UsageReset } from "../../src/Subscription/ClosePeriod.command.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import {
  billedOf,
  remainingOf,
  reservedOf,
  rollsPeriod,
  usedOf,
  type SubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import {
  decideAt,
  evolveAt,
  isAccepted,
  start,
  subscribedAt,
  subscribedIn,
} from "./Arbitraries.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);
const days = (value: number) => value * 24 * 60 * 60 * 1_000;

const seats = feature({ id: "seats", name: "Seats" });

const closeCatalog = Effect.runSync(
  catalog({
    features: [messages, seats],
    tiers: [
      tier({
        id: "kept",
        price: { amount: 1_900, currency: "usd", interval: "month" },
        grants: [
          allowance(messages, { included: 100, overage: "bill" }),
          // A `resets: "never"` postpaid feature keeps its use, holds and
          // billed money across the close.
          allowance(seats, {
            included: 10,
            overage: "bill",
            resets: "never",
            unitPrice: { amount: 3, currency: "usd" },
          }),
        ],
      }),
    ],
  }),
);

const closeCommand = (state: SubscribedState): ClosePeriod =>
  new ClosePeriod({ periodEnd: state.period.end });

const actionFor = (state: SubscriptionState, periodEnd: DateTime.Utc, now: DateTime.Utc) => {
  const decision = decideAt(state, new ClosePeriod({ periodEnd }), now, "probe-close");
  return decision;
};

const expectedCanClose = (
  state: SubscribedState,
  periodEnd: DateTime.Utc,
  now: DateTime.Utc,
): boolean =>
  rollsPeriod(state.status) &&
  DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(periodEnd) &&
  DateTime.toEpochMillis(periodEnd) === DateTime.toEpochMillis(state.period.end) &&
  (state.lastClosedPeriodStart === undefined ||
    DateTime.toEpochMillis(state.lastClosedPeriodStart) !==
      DateTime.toEpochMillis(state.period.start));

describe("period close", () => {
  it.effect("closes exactly once, when now has reached the open period's end", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          periodEndOffsetDays: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: -2, maximum: 2 })),
          ),
          nowOffsetDays: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: -10, maximum: 1 })),
          ),
          alreadyClosed: Schema.Boolean,
        }),
      ),
      ({ periodEndOffsetDays, nowOffsetDays, alreadyClosed }) => {
        let state: SubscriptionState = subscribedAt("pro");
        if (alreadyClosed) {
          const decision = decideAt(
            state,
            new ClosePeriod({ periodEnd: state.period.end }),
            state.period.end,
            "first-close",
          );
          if (!isAccepted(decision)) return false;
          state = evolveAt(state, decision, state.period.end, "first-close");
        }
        if (state._tag !== "Subscribed") return false;

        const periodEnd = at(DateTime.toEpochMillis(state.period.end) + days(periodEndOffsetDays));
        const now = at(DateTime.toEpochMillis(state.period.end) + days(nowOffsetDays));
        const canClose = canClosePeriod(state, periodEnd, now);
        if (canClose !== expectedCanClose(state, periodEnd, now)) return false;

        const decision = actionFor(state, periodEnd, now);
        if (canClose !== isAccepted(decision)) return false;
        if (!canClose && (decision as { readonly _tag: string })._tag !== "PeriodNotClosed")
          return false;
        return true;
      },
      { runs: 100, size: 20 },
    ),
  );

  it.effect("a kept allowance preserves use, holds and billed money over a close", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          messageUse: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
          seatUse: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 30 }))),
          held: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
        }),
      ),
      ({ messageUse, seatUse, held }) => {
        let state: SubscribedState = subscribedIn(closeCatalog, "kept");
        const messageDecision = decideAt(
          state,
          new TrackUsage({ feature: "messages", amount: messageUse }),
          start,
          "messages",
        );
        if (!isAccepted(messageDecision)) return false;
        state = evolveAt(state, messageDecision, start, "messages") as SubscribedState;

        const seatDecision = decideAt(
          state,
          new TrackUsage({ feature: "seats", amount: seatUse }),
          start,
          "seats",
        );
        if (!isAccepted(seatDecision)) return false;
        state = evolveAt(state, seatDecision, start, "seats") as SubscribedState;

        if (held > 0) {
          const heldDecision = decideAt(
            state,
            new Hold({
              holdId: "kept-hold",
              feature: "seats",
              amount: held,
              expiresAt: DateTime.add(state.period.end, { days: 30 }),
            }),
            start,
            "held",
          );
          if (!isAccepted(heldDecision)) return false;
          state = evolveAt(state, heldDecision, start, "held") as SubscribedState;
        }

        const beforeMessagesUsed = usedOf(state, "messages");
        const beforeSeatsUsed = usedOf(state, "seats");
        const beforeSeatsReserved = reservedOf(state, "seats");
        const beforeSeatsRemaining = remainingOf(state, "seats");
        const beforeSeatsBilled = billedOf(state, "seats");

        const close = decideAt(state, closeCommand(state), state.period.end, "close");
        if (!isAccepted(close)) return false;
        const reset = close.find((event) => event._tag === "UsageReset") as UsageReset | undefined;
        if (reset === undefined) return false;
        if (reset.kept?.seats !== true) return false;
        if (reset.kept.messages === true) return false;

        const after = evolveAt(state, close, state.period.end, "close");
        if (after._tag !== "Subscribed") return false;

        // The kept feature is untouched; the resetting one starts clean.
        if (usedOf(after, "seats") !== beforeSeatsUsed) return false;
        if (reservedOf(after, "seats") !== beforeSeatsReserved) return false;
        if (remainingOf(after, "seats") !== beforeSeatsRemaining) return false;
        if (billedOf(after, "seats") !== beforeSeatsBilled) return false;
        if (usedOf(after, "messages") !== 0) return false;
        if (reservedOf(after, "messages") !== 0) return false;
        if (remainingOf(after, "messages") !== 100) return false;
        if (beforeMessagesUsed > 0 && reset.carried.messages !== 0) return false;

        return true;
      },
      { runs: 80, size: 30 },
    ),
  );
});
