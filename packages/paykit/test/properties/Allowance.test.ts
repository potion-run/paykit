import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { allowancesOf } from "../../src/Catalog.ts";
import {
  initialSubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage, type UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
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
  TierName,
} from "./Arbitraries.ts";

const account = "acct_property";

const UsageStep = Schema.Struct({ amount: Amount, dedupeKey: DedupeKey });
const UsageScript = Schema.Struct({
  tier: TierName,
  steps: Schema.Array(UsageStep).pipe(Schema.check(Schema.isMaxLength(60))),
});

const activated = (tier: TierName): SubscribedState => {
  const allowances = allowancesOf(testCatalog, tier)!;
  const decision = decideAt(
    initialSubscriptionState,
    commandOf({ _tag: "Subscribe", tier }, initialSubscriptionState, start),
    start,
    "subscribe",
  );
  if (!isAccepted(decision)) throw new Error(`the generated catalog could not activate ${tier}`);
  const state = evolveAt(initialSubscriptionState, decision, start, "subscribe");
  if (state._tag !== "Subscribed") throw new Error("Subscribe did not activate a standing");
  expect(allowances).toEqual(state.allowances);
  return state;
};

const track = (amount: number, dedupeKey?: string) =>
  new TrackUsage({
    feature: "messages",
    amount,
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
  });

describe("allowance", () => {
  it.effect("never lets a blocking allowance overspend or go negative", () =>
    assertProperty(
      Arbitrary.schema(UsageScript),
      (script) => {
        const unlimited = script.tier === "unlimited";
        const bill = script.tier === "pro";
        let state = activated(script.tier);
        const included = state.allowances.messages?.included;
        if (included === undefined) return false;
        const limit = included === "unlimited" ? null : included;
        if (!unlimited && limit === null) return false;
        let remaining = state.remaining.messages;
        let used = state.usage.messages ?? 0;

        for (const step of script.steps) {
          const decision = decideAt(state, track(step.amount, step.dedupeKey), start, account);
          if (!isAccepted(decision)) {
            // Only a block can refuse the generated tiers: every request is
            // positive and the feature exists in the tier.
            if (decision._tag !== "AllowanceExceeded") return false;
            if (unlimited || bill) return false;
            // The refusal carries the count the model held before it.
            const rejection = decision as unknown as { readonly remaining: number };
            if (step.amount <= rejection.remaining) return false;
            continue;
          }

          // An empty decision is a deduped retry: nothing moved.
          if (decision.length === 0) continue;

          const event = decision[0] as UsageRecorded;
          const expectedUsed = used + step.amount;
          const expectedRemaining = remaining === null ? null : remaining - step.amount;
          if (event.usedAfter !== expectedUsed) return false;
          if (event.remainingAfter !== expectedRemaining) return false;
          if (unlimited && event.remainingAfter !== null) return false;
          if (!unlimited && (event.remainingAfter ?? 0) < 0 && !bill) return false;
          if (limit !== null && event.usedAfter > limit && !bill) return false;

          state = evolveAt(state, decision, start, account) as SubscribedState;
          used = event.usedAfter;
          remaining = event.remainingAfter;
        }

        // A count is conserved: used + remaining = included for a blocking
        // allowance, and used + (negative remaining) = included for billing.
        if (unlimited || limit === null) return true;
        return (state.usage.messages ?? 0) + (state.remaining.messages ?? 0) === limit;
      },
      { runs: 80, size: 40 },
    ),
  );

  it.effect("closes a period back to what the tier includes, or what it carried", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          tier: Schema.Literals(["free", "carry"]),
          steps: Schema.Array(UsageStep).pipe(Schema.check(Schema.isMaxLength(40))),
        }),
      ),
      (script) => {
        let state = activated(script.tier);
        for (const step of script.steps) {
          const decision = decideAt(state, track(step.amount, step.dedupeKey), start, account);
          if (isAccepted(decision) && decision.length > 0) {
            state = evolveAt(state, decision, start, account) as SubscribedState;
          }
        }

        const remainingBefore = state.remaining.messages ?? 0;
        const end = state.period.end;
        const closed = decideAt(
          state,
          commandOf({ _tag: "ClosePeriod" }, state, end),
          end,
          "close",
        );
        if (!isAccepted(closed)) return false;
        const reset = closed.find((event) => event._tag === "UsageReset") as
          | {
              readonly remaining: Readonly<Record<string, number | null>>;
              readonly carried: Readonly<Record<string, number>>;
            }
          | undefined;
        if (reset === undefined) return false;

        const after = evolveAt(state, closed, end, "close");
        if (after._tag !== "Subscribed") return false;
        if ((after.usage.messages ?? 0) !== 0) return false;
        if (after.credits !== 0) return false;
        if (DateTime.toEpochMillis(after.period.start) !== DateTime.toEpochMillis(end))
          return false;

        const carried = script.tier === "carry" ? Math.min(Math.max(remainingBefore, 0), 100) : 0;
        if (reset.carried.messages !== carried) return false;
        return after.remaining.messages === 100 + carried;
      },
      { runs: 80, size: 30 },
    ),
  );

  it("a bill allowance may go past its included amount and stay reproducible", () => {
    const state = activated("pro");
    const decision = decideAt(state, track(2_500), start, account);
    expect(isAccepted(decision)).toBe(true);
    if (!isAccepted(decision)) return;
    const event = decision[0] as UsageRecorded;
    expect(event.usedAfter).toBe(2_500);
    expect(event.remainingAfter).toBe(-500);
  });
});
