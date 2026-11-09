import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { messages } from "../../src/Feature.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { CurrencyMismatch } from "../../src/Subscription/CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "../../src/Subscription/NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "../../src/Subscription/PlanNotInCatalog.rejection.ts";
import { PlanPhaseNamesAddOn } from "../../src/Subscription/PlanPhaseNamesAddOn.rejection.ts";
import { PlanPhaseNotFuture } from "../../src/Subscription/PlanPhaseNotFuture.rejection.ts";
import {
  ScheduleTierChange,
  PlanChangeScheduled,
} from "../../src/Subscription/ScheduleTierChange.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  creditsExpireOf,
  pendingPlanOf,
  planIdOf,
  planRowsOf,
  scheduleOf,
  topUpTermsOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import {
  NoTierChangeScheduled,
  TierChangeWithdrawn,
  WithdrawTierChange,
} from "../../src/Subscription/WithdrawTierChange.command.ts";
import { planPhase, soldPlan } from "../support/Plans.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const monthAfterThat = DateTime.makeUnsafe("2030-03-01T00:00:00Z");
const id = Subscription.ref("acct_scheduled").id;
const context = Context.make(Actor, system("test"));

const pro = allowance(messages, { included: 100, overage: "bill" });
const small = allowance(messages, { included: 20, overage: "block" });
const lifetime = allowance(messages, { included: 20, overage: "block", resets: "never" });

/** A standing mid-period, using more than the tier it is about to move to. */
const subscribed = (overrides: Partial<SubscribedState> = {}): SubscribedState =>
  ({
    _tag: "Subscribed",
    plans: soldPlan("pro", {
      allowances: { messages: pro },
      credits: 0,
      creditsExpire: "period",
      rates: {},
      currency: "usd",
      interval: "month",
    }),
    schedule: [],
    status: "active",
    period: { start, end: monthLater, anchorTz: "UTC" },
    cancelAtPeriodEnd: false,
    credits: 0,
    usage: { messages: 60 },
    remaining: { messages: 40 },
    holds: {},
    refs: {},
    trialUsed: true,
    dedupeKeys: {},
    dunningAttempts: 0,
    ...overrides,
  }) as never;

const schedule = (over: Partial<ConstructorParameters<typeof ScheduleTierChange>[0]> = {}) =>
  new ScheduleTierChange({
    tier: "small",
    allowances: { messages: small },
    credits: 0,
    creditsExpire: "period",
    topUp: { threshold: 20 },
    rates: {},
    ...over,
  });

const closeOf = (state: SubscribedState, now: DateTime.Utc) =>
  Subscription.predict(
    state,
    new ClosePeriod({
      periodEnd: state.period.end,
      input: { periodEnd: state.period.end },
    } as never),
    { id, now, context },
  );

const accepted = (verdict: ReturnType<typeof closeOf>): SubscribedState => {
  expect(verdict._tag).toBe("Accepted");

  return verdict._tag === "Accepted" ? (verdict.state as SubscribedState) : (undefined as never);
};

describe("a plan change scheduled for an instant", () => {
  it("is recorded on the standing, not applied now", () => {
    const verdict = Subscription.predict(subscribed(), schedule(), { id, now: start, context });
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    expect(verdict.events).toHaveLength(1);
    expect(verdict.events[0]).toBeInstanceOf(PlanChangeScheduled);
    expect(verdict.events[0]).toMatchObject({
      tier: "small",
      allowances: { messages: small },
      topUp: { threshold: 20 },
      at: monthLater,
    });

    const after = verdict.state as SubscribedState;
    // The plan has not moved; the phase waits for its instant.
    expect(planIdOf(after)).toBe("pro");
    expect(pendingPlanOf(after)?.planId).toBe("small");
    expect(pendingPlanOf(after)?.at).toEqual(monthLater);
  });

  it("lands at the boundary, before the counters reset onto the new allowances", () => {
    const state = subscribed({
      schedule: [planPhase("small", monthLater, { allowances: { messages: small } })],
    });

    const verdict = closeOf(state, monthLater);
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;

    const tags = verdict.events.map((event) => event._tag);
    // The change first: `UsageReset` reads the allowances in state, so a reset
    // emitted ahead of it would start the period on the tier being left.
    expect(tags.indexOf("PlanChanged")).toBe(0);
    expect(tags).toContain("PeriodClosed");

    const [changed] = verdict.events as ReadonlyArray<{
      _tag: string;
      allowances?: unknown;
      topUp?: { threshold: number };
    }>;

    expect(changed?.allowances).toEqual({ messages: small });

    const reset = verdict.events.find((event) => event._tag === "UsageReset");
    // The new plan's included count, not the old one and not the usage carried
    // across a boundary it was never part of.
    expect(reset).toMatchObject({ remaining: { messages: 20 } });

    const after = verdict.state as SubscribedState;
    expect(planIdOf(after)).toBe("small");
    expect(scheduleOf(after)).toHaveLength(0);
  });

  it("applies two phases in order, one boundary apart", () => {
    // The model's scenario: attach, schedule two phases, close, close. The
    // second phase is still ahead of the first boundary, so it survives it.
    const state = subscribed({
      schedule: [
        planPhase("small", monthLater, { allowances: { messages: small } }),
        planPhase("lifetime", monthAfterThat, { allowances: { messages: lifetime } }),
      ],
    });

    const first = closeOf(state, monthLater);
    expect(first._tag).toBe("Accepted");

    if (first._tag !== "Accepted") return;

    const firstChange = first.events.find((event) => event._tag === "PlanChanged") as
      | { readonly tier: string }
      | undefined;

    expect(firstChange?.tier).toBe("small");

    const afterFirst = first.state as SubscribedState;
    expect(planIdOf(afterFirst)).toBe("small");
    expect(scheduleOf(afterFirst).map((phase) => phase.planId)).toEqual(["lifetime"]);

    const second = closeOf(afterFirst, monthAfterThat);
    expect(second._tag).toBe("Accepted");

    if (second._tag !== "Accepted") return;

    const secondChange = second.events.find((event) => event._tag === "PlanChanged") as
      | { readonly tier: string }
      | undefined;

    expect(secondChange?.tier).toBe("lifetime");
    expect(planIdOf(second.state as SubscribedState)).toBe("lifetime");
    expect(scheduleOf(second.state as SubscribedState)).toHaveLength(0);
  });

  it("schedules the same plan at one instant, replacing its earlier phase", () => {
    const state = subscribed({
      schedule: [planPhase("small", monthLater, { allowances: { messages: small } })],
    });

    const verdict = Subscription.predict(state, schedule(), { id, now: start, context });
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    expect(scheduleOf(verdict.state as SubscribedState)).toHaveLength(1);
  });
});

describe("a move supersedes the phase it overlaps", () => {
  it("drops the phases its own group had waiting", () => {
    const state = subscribed({
      schedule: [planPhase("small", monthLater, { allowances: { messages: small } })],
    });

    const verdict = Subscription.predict(
      state,
      new ChangeTier({
        tier: "pro",
        allowances: { messages: pro },
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
      { id, now: start, context },
    );

    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    // The account already moved; keeping the phase would silently undo it.
    expect(scheduleOf(verdict.state as SubscribedState)).toHaveLength(0);
  });
});

describe("a top-up line on the plan", () => {
  it("moves with a mid-period change, and is cleared by a plan that states none", () => {
    const state = subscribed({
      plans: soldPlan("pro", {
        allowances: { messages: pro },
        credits: 0,
        creditsExpire: "period",
        rates: {},
        currency: "usd",
        interval: "month",
        topUp: { threshold: 500 },
      }),
    });

    const verdict = Subscription.predict(
      state,
      new ChangeTier({
        tier: "pro",
        allowances: { messages: pro },
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
      { id, now: start, context },
    );

    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    // The new plan did not state a line, so the old one does not survive it.
    expect(verdict.events[0]).not.toHaveProperty("topUp");
    expect(topUpTermsOf(verdict.state as SubscribedState)).toBeUndefined();
  });

  it("lands with a scheduled phase at the boundary", () => {
    const state = subscribed({
      schedule: [
        planPhase("small", monthLater, {
          allowances: { messages: small },
          topUp: { threshold: 20 },
        }),
      ],
    });

    const verdict = closeOf(state, monthLater);
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;

    const changed = verdict.events.find((event) => event._tag === "PlanChanged");
    expect(changed).toMatchObject({ topUp: { threshold: 20 } });
    expect(topUpTermsOf(verdict.state as SubscribedState)).toEqual({ threshold: 20 });
  });
});

describe("withdrawing a scheduled phase", () => {
  const pending = () => ({
    schedule: [planPhase("small", monthLater, { allowances: { messages: small } })],
  });

  it("records the intent it abandoned and leaves the standing where it is", () => {
    const state = subscribed(pending());

    const verdict = Subscription.predict(state, new WithdrawTierChange(), {
      id,
      now: start,
      context,
    });

    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    expect(verdict.events).toHaveLength(1);
    // The log keeps which change was abandoned, so the event is the only record
    // of an intent that was dropped rather than replaced.
    expect(verdict.events[0]).toBeInstanceOf(TierChangeWithdrawn);
    expect(verdict.events[0]).toMatchObject({ tier: "small" });

    const after = verdict.state as SubscribedState;
    expect(pendingPlanOf(after)).toBeUndefined();
    // Nothing else moved: same plan, same counters, same period.
    expect(planIdOf(after)).toBe(planIdOf(state));
    expect(after.usage).toEqual(state.usage);
    expect(after.remaining).toEqual(state.remaining);
    expect(after.period).toEqual(state.period);
  });

  it("then closes the period on the plan the account is on", () => {
    const state = subscribed(pending());

    const verdict = Subscription.predict(state, new WithdrawTierChange(), {
      id,
      now: start,
      context,
    });

    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;

    const closed = closeOf(verdict.state as SubscribedState, monthLater);
    expect(closed._tag).toBe("Accepted");

    if (closed._tag !== "Accepted") return;
    // No `PlanChanged`: the withdrawn phase does not land at the boundary.
    expect(closed.events.map((event) => event._tag)).not.toContain("PlanChanged");
    expect(planIdOf(closed.state as SubscribedState)).toBe("pro");
  });

  it("refuses when nothing is scheduled, rather than recording an empty intent", () => {
    const verdict = Subscription.predict(subscribed(), new WithdrawTierChange(), {
      id,
      now: start,
      context,
    });

    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(NoTierChangeScheduled);
  });

  it("refuses for an account with no standing", () => {
    const verdict = Subscription.predict(
      { _tag: "Unsubscribed", refs: {} } as never,
      new WithdrawTierChange(),
      { id, now: start, context },
    );

    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(NotSubscribed);
  });
});

describe("what a schedule refuses", () => {
  it("an empty grant: that is a one-off pack, not a plan", () => {
    // A pack has no allowances, and the boundary would apply those terms
    // verbatim: the standing would lose every allowance and take the pack's
    // credits as its pool, having paid for a pack rather than a plan.
    const verdict = Subscription.predict(subscribed(), schedule({ allowances: {} }), {
      id,
      now: start,
      context,
    });

    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(PlanNotInCatalog);
  });

  it("a price in another currency than the standing's", () => {
    const verdict = Subscription.predict(
      subscribed(),
      schedule({ price: { amount: 1_900, currency: "eur", interval: "month" } }),
      { id, now: start, context },
    );

    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(CurrencyMismatch);
  });

  it("a phase whose instant is not in the future", () => {
    const verdict = Subscription.predict(subscribed(), schedule({ at: start }), {
      id,
      now: start,
      context,
    });

    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(PlanPhaseNotFuture);
  });

  it("a phase that names an add-on", () => {
    // A phase replaces a group's plan; an add-on replaces nothing (ADR 0039 §4).
    const verdict = Subscription.predict(subscribed(), schedule({ addOn: true }), {
      id,
      now: start,
      context,
    });

    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(PlanPhaseNamesAddOn);
  });
});

describe("the pool at the boundary", () => {
  const monthly = {
    allowances: { messages: small },
    credits: 500,
    currency: "usd",
    interval: "month" as const,
  };

  it("grants the new plan's pool, and expires it at the next close", () => {
    // The account is on a pool that does not expire and moves to one that does.
    // The boundary grants the new plan's credits for the period starting here;
    // the old grant is replaced, so this close has nothing of its own to expire.
    const state = subscribed({
      credits: 0,
      plans: soldPlan("pro", {
        allowances: { messages: pro },
        credits: 0,
        creditsExpire: "never",
        rates: {},
        currency: "usd",
        interval: "month",
      }),
      schedule: [planPhase("monthly", monthLater, monthly)],
    });

    const verdict = closeOf(state, monthLater);
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;

    const changed = verdict.events.find((event) => event._tag === "PlanChanged") as
      | { readonly credits: number }
      | undefined;

    expect(changed?.credits).toBe(500);
    expect(verdict.events.map((event) => event._tag)).not.toContain("CreditsExpired");
    expect((verdict.state as SubscribedState).credits).toBe(500);
    expect(creditsExpireOf(verdict.state as SubscribedState)).toBe("period");

    // The new grant is for the new period, so its own rule applies at its close.
    const next = closeOf(accepted(verdict), monthAfterThat);
    expect(next._tag).toBe("Accepted");

    if (next._tag !== "Accepted") return;

    const expired = next.events.find((event) => event._tag === "CreditsExpired") as
      | { readonly amount: number; readonly balanceAfter: number }
      | undefined;

    expect(expired).toMatchObject({ amount: 500, balanceAfter: 0 });
    expect((next.state as SubscribedState).credits).toBe(0);
  });

  it("keeps what a one-off pack bought, and keeps protecting it", () => {
    // 100 of the 120 in the pool came from a pack. The new grant replaces the
    // plan's 20 and keeps the pack; the new grant is not expired at the
    // boundary it starts, so the pack stays protected for the next period.
    const state = subscribed({
      credits: 120,
      prepaidCredits: 100,
      schedule: [planPhase("monthly", monthLater, monthly)],
    });

    const verdict = closeOf(state, monthLater);
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;

    const changed = verdict.events.find((event) => event._tag === "PlanChanged") as
      | { readonly credits: number; readonly prepaidCredits?: number }
      | undefined;

    expect(changed?.credits).toBe(600);
    expect(changed?.prepaidCredits).toBe(100);
    expect(verdict.events.map((event) => event._tag)).not.toContain("CreditsExpired");

    const after = verdict.state as SubscribedState;
    expect(after.credits).toBe(600);
    expect(after.prepaidCredits).toBe(100);

    // The plan's part of the new pool expires next period; the pack does not.
    const next = closeOf(after, monthAfterThat);
    expect(next._tag).toBe("Accepted");

    if (next._tag !== "Accepted") return;

    const expired = next.events.find((event) => event._tag === "CreditsExpired") as
      | { readonly amount: number; readonly balanceAfter: number }
      | undefined;

    expect(expired).toMatchObject({ amount: 500, balanceAfter: 100 });
    expect((next.state as SubscribedState).credits).toBe(100);
    expect((next.state as SubscribedState).prepaidCredits).toBe(100);
  });

  it("replaces the old plan's grant without expiring the new one", () => {
    const state = subscribed({
      credits: 40,
      schedule: [planPhase("monthly", monthLater, monthly)],
    });

    const verdict = closeOf(state, monthLater);
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    expect(verdict.events.map((event) => event._tag)).not.toContain("CreditsExpired");
    expect((verdict.state as SubscribedState).credits).toBe(500);
  });

  it("grants nothing extra when the plan it moves to keeps its pool", () => {
    const state = subscribed({
      credits: 40,
      schedule: [planPhase("monthly", monthLater, { ...monthly, creditsExpire: "never" })],
    });

    const verdict = closeOf(state, monthLater);
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    expect(verdict.events.map((event) => event._tag)).not.toContain("CreditsExpired");
    expect((verdict.state as SubscribedState).credits).toBe(500);

    const next = closeOf(accepted(verdict), monthAfterThat);
    expect(next._tag).toBe("Accepted");

    if (next._tag !== "Accepted") return;
    expect(next.events.map((event) => event._tag)).not.toContain("CreditsExpired");
    expect((next.state as SubscribedState).credits).toBe(500);
  });
});

it("starts every counter over, including a resets:never one", () => {
  // The account used 60 units on `pro` and scheduled a move to a plan whose
  // allowance never resets. Keeping that count would be a count against an
  // allowance that never granted those units: the plan changed, so the counter
  // the next period runs on is the new allowance's.
  const state = subscribed({
    schedule: [planPhase("lifetime", monthLater, { allowances: { messages: lifetime } })],
  });

  const verdict = closeOf(state, monthLater);
  expect(verdict._tag).toBe("Accepted");

  if (verdict._tag !== "Accepted") return;

  const reset = verdict.events.find((event) => event._tag === "UsageReset") as
    | { readonly remaining: Record<string, number | null>; readonly kept?: Record<string, boolean> }
    | undefined;

  expect(reset?.remaining.messages).toBe(20);
  expect(reset?.kept?.messages).toBeUndefined();
  const after = verdict.state as SubscribedState;
  expect(after.usage.messages).toBeUndefined();
  expect(after.remaining.messages).toBe(20);
});

it("keeps a resets:never count across a close that changes no plan", () => {
  const state = subscribed({
    plans: soldPlan("lifetime", { allowances: { messages: lifetime } }),
  });

  const verdict = closeOf(state, monthLater);
  expect(verdict._tag).toBe("Accepted");

  if (verdict._tag !== "Accepted") return;

  const reset = verdict.events.find((event) => event._tag === "UsageReset") as
    | { readonly kept?: Record<string, boolean> }
    | undefined;

  expect(reset?.kept?.messages).toBe(true);
  expect((verdict.state as SubscribedState).usage.messages).toBe(60);
});

it("keeps the plan set it landed on", () => {
  const state = subscribed({
    schedule: [planPhase("small", monthLater, { allowances: { messages: small } })],
  });

  const verdict = closeOf(state, monthLater);
  expect(verdict._tag).toBe("Accepted");

  if (verdict._tag !== "Accepted") return;

  const after = verdict.state as SubscribedState;
  expect(planRowsOf(after).map((row) => row.planId)).toEqual(["small"]);
});
