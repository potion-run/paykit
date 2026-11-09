import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { allowance } from "../../src/Allowance.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { EnterGrace, GraceDeadlineNotLater } from "../../src/Subscription/EnterGrace.command.ts";
import { SubscriptionExpired } from "../../src/Subscription/Expire.command.ts";
import { GraceElapsed } from "../../src/Subscription/GraceElapsed.command.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { RecordTopUpFailure } from "../../src/Subscription/RecordTopUpFailure.command.ts";
import { ResetAllowance } from "../../src/Subscription/ResetAllowance.command.ts";
import { ScheduleCancellation } from "../../src/Subscription/ScheduleCancellation.command.ts";
import { ScheduleTierChange } from "../../src/Subscription/ScheduleTierChange.command.ts";
import { standingConditionsOf } from "../../src/Subscription/StandingPhase.ts";
import { planIdOf, type SubscribedState } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import {
  type Decision,
  decideAt,
  evolveAt,
  isAccepted,
  prorationFor,
  start,
  subscribedIn,
  testCatalog,
} from "../properties/Arbitraries.ts";

const accepted = (decision: Decision): ReadonlyArray<{ readonly _tag: string }> => {
  if (!isAccepted(decision)) {
    throw new Error(`expected an accepted decision, got ${decision._tag}`);
  }

  return decision;
};

const subscribed = (state: ReturnType<typeof evolveAt>): SubscribedState => {
  if (state._tag !== "Subscribed") throw new Error("expected a subscribed standing");

  return state;
};

const dayLater = DateTime.add(start, { days: 1 });
const daysLater = (days: number) => DateTime.add(start, { days });

const daily = tier({
  id: "daily",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 10, resets: "day" })],
});

const dailyCatalog = Effect.runSync(catalog({ features: [messages], tiers: [daily] }));

const endOfPeriod = (state: SubscribedState) => state.period.end;

const changeTier = (state: SubscribedState, tierId: "pro" | "scale") => {
  const terms = planTermsOf(testCatalog, tierId);

  if (terms === null) throw new Error(`the fixture catalog has no ${tierId}`);

  return decideAt(
    state,
    new ChangeTier({ tier: tierId, ...terms, proration: prorationFor(state, tierId, start) }),
    start,
    `change-${tierId}`,
  );
};

describe("a tier change resets the refill budget", () => {
  it("clears topUpAttempts but keeps the failure as history", () => {
    const pro = subscribedIn(testCatalog, "pro");

    const failed = subscribed(
      evolveAt(
        pro,
        accepted(
          decideAt(
            pro,
            new RecordTopUpFailure({
              tier: "credits_1k",
              provider: "test",
              reason: "card_declined",
            }),
            start,
            "top-up-failure",
          ),
        ),
        start,
        "top-up-failure",
      ),
    );

    expect(failed.topUpAttempts).toBe(1);
    expect(failed.topUpFailure?.reason).toBe("card_declined");

    const changed = subscribed(
      evolveAt(failed, accepted(changeTier(failed, "scale")), start, "move"),
    );

    expect(planIdOf(changed)).toBe("scale");
    expect(changed.topUpAttempts).toBe(0);
    expect(changed.topUpFailure?.reason).toBe("card_declined");
  });
});

describe("a terminal standing has no window to reset", () => {
  it("records nothing when a daily boundary fires after expiry", () => {
    const opened = subscribedIn(dailyCatalog, "daily");

    expect(opened.resetAt?.messages).toBeDefined();

    const expired = subscribed(
      evolveAt(opened, [new SubscriptionExpired({ statusAfter: "expired" })], dayLater, "expire"),
    );

    const reset = decideAt(
      expired,
      new ResetAllowance({ feature: "messages", at: opened.resetAt!.messages }),
      dayLater,
      "reset",
    );

    expect(reset).toEqual([]);
    expect(expired.status).toBe("expired");
    expect(expired.resetAt?.messages).toBe(opened.resetAt?.messages);
  });
});

describe("grace is a forward window", () => {
  it("refuses a deadline at or before now", () => {
    const pro = subscribedIn(testCatalog, "pro");
    const now = daysLater(10);

    for (const graceUntil of [now, daysLater(9)]) {
      const entered = decideAt(pro, new EnterGrace({ graceUntil }), now, "grace");

      expect(isAccepted(entered)).toBe(false);

      const refusal = entered as InstanceType<typeof GraceDeadlineNotLater>;

      expect(refusal._tag).toBe("GraceDeadlineNotLater");
      expect(refusal.current).toBe(now);
      expect(refusal.requested).toBe(graceUntil);
    }
  });

  it("records no failure when a stale webhook has no live window", () => {
    const pro = subscribedIn(testCatalog, "pro");
    const now = daysLater(10);

    const failed = decideAt(
      pro,
      new RecordPaymentFailure({ reason: "card_declined", graceUntil: daysLater(9) }),
      now,
      "failure",
    );

    expect(failed).toEqual([]);
    expect(pro.graceUntil).toBeUndefined();
  });
});

describe("a terminal standing carries no pending tier", () => {
  it("drops a scheduled change when grace expires", () => {
    const free = subscribedIn(testCatalog, "free");
    const terms = planTermsOf(testCatalog, "pro")!;

    const scheduled = subscribed(
      evolveAt(
        free,
        accepted(
          decideAt(free, new ScheduleTierChange({ tier: "pro", ...terms }), start, "schedule"),
        ),
        start,
        "schedule",
      ),
    );

    expect(standingConditionsOf(scheduled, start).pendingTier).toBe("pro");

    const graceUntil = daysLater(5);

    const entered = subscribed(
      evolveAt(
        scheduled,
        accepted(decideAt(scheduled, new EnterGrace({ graceUntil }), start, "grace")),
        start,
        "grace",
      ),
    );

    const expired = subscribed(
      evolveAt(
        entered,
        accepted(decideAt(entered, new GraceElapsed(), graceUntil, "elapsed")),
        graceUntil,
        "elapsed",
      ),
    );

    expect(expired.status).toBe("expired");
    expect(expired.schedule).toEqual([]);
    expect(standingConditionsOf(expired, graceUntil).pendingTier).toBeNull();
  });
});

describe("a cancellation wins the boundary", () => {
  it("withdraws a pending tier instead of applying it on a canceled close", () => {
    const free = subscribedIn(testCatalog, "free");
    const terms = planTermsOf(testCatalog, "pro")!;

    const scheduled = subscribed(
      evolveAt(
        free,
        accepted(
          decideAt(free, new ScheduleTierChange({ tier: "pro", ...terms }), start, "schedule"),
        ),
        start,
        "schedule",
      ),
    );

    const canceled = subscribed(
      evolveAt(
        scheduled,
        accepted(decideAt(scheduled, new ScheduleCancellation(), start, "cancel")),
        start,
        "cancel",
      ),
    );

    const boundary = endOfPeriod(canceled);
    const closed = decideAt(canceled, new ClosePeriod({ periodEnd: boundary }), boundary, "close");

    expect(isAccepted(closed)).toBe(true);

    const events = accepted(closed);

    expect(events.some((event) => event._tag === "PlanChanged")).toBe(false);
    expect(events.some((event) => event._tag === "PeriodClosed")).toBe(true);

    const after = subscribed(evolveAt(canceled, events, boundary, "close"));

    expect(after.status).toBe("canceled");
    expect(planIdOf(after)).toBe("free");
    expect(after.schedule).toEqual([]);
    expect(standingConditionsOf(after, boundary).pendingTier).toBeNull();
  });
});
