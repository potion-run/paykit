import { describe, expect, it } from "@alchemy.run/test";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ClosePeriod, UsageReset } from "../../src/Subscription/ClosePeriod.command.ts";
import { availableOf, type SubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { decideAt, evolveAt, isAccepted, start, subscribedAt } from "./Arbitraries.ts";

/**
 * The one derived number in a judgment: the write path knows `included`, the
 * read model knows `carried`, and the ceiling is written from `remaining`. A
 * capped allowance that carries what it did not spend is where the two meet —
 * the carried units spend the cap, they do not extend it.
 */
describe("a capped allowance that carries over", () => {
  it("spends the cap with the carried units instead of extending it", () => {
    // `carry-cap` includes 100, bills 20 more, and carries at most 100.
    let state: SubscriptionState = subscribedAt("carry-cap");

    const periodEnd = (current: SubscriptionState): DateTime.Utc => {
      if (current._tag !== "Subscribed") throw new Error("the standing was lost");

      return current.period.end;
    };

    const first = decideAt(
      state,
      new TrackUsage({ feature: "messages", amount: 90, dedupeKey: "first" }),
      start,
      "first",
    );

    if (!isAccepted(first)) throw new Error("the first usage was refused");
    state = evolveAt(state, first, start, "first");

    // Ten units are left, so ten carry in and the next period starts at 110
    // spendable. The ceiling stays `included + cap` = 120 units, not 130.
    const close = decideAt(
      state,
      new ClosePeriod({ periodEnd: periodEnd(state) }),
      periodEnd(state),
      "close",
    );

    if (!isAccepted(close)) throw new Error("the period did not close");
    const reset = close.find(Schema.is(UsageReset));
    expect(reset?.carried.messages).toBe(10);
    state = evolveAt(state, close, periodEnd(state), "close");

    if (state._tag !== "Subscribed") throw new Error("the close lost the standing");
    expect(availableOf(state, "messages")).toBe(110);

    const all = decideAt(
      state,
      new TrackUsage({ feature: "messages", amount: 120, dedupeKey: "all" }),
      periodEnd(state),
      "all",
    );

    if (!isAccepted(all)) throw new Error("120 units should fit the 120-unit ceiling");
    state = evolveAt(state, all, periodEnd(state), "all");

    // A `judgedOf` that read the rollover as zero would still see 130 units of
    // room here, and would accept this one.
    const past = decideAt(
      state,
      new TrackUsage({ feature: "messages", amount: 1, dedupeKey: "past" }),
      periodEnd(state),
      "past",
    );

    if (isAccepted(past)) throw new Error("the 121st unit was accepted");
    expect(past._tag).toBe("SpendCapExceeded");
  });
});
