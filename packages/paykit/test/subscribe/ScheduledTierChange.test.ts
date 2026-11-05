import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { messages } from "../../src/Feature.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { CurrencyMismatch } from "../../src/Subscription/CurrencyMismatch.rejection.ts";
import { NotSubscribed } from "../../src/Subscription/NotSubscribed.rejection.ts";
import {
  ScheduleTierChange,
  TierChangeScheduled,
} from "../../src/Subscription/ScheduleTierChange.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { SubscribedState } from "../../src/Subscription/Subscription.state.ts";
import { TierNotInCatalog } from "../../src/Subscription/TierNotInCatalog.rejection.ts";
import {
  NoTierChangeScheduled,
  TierChangeWithdrawn,
  WithdrawTierChange,
} from "../../src/Subscription/WithdrawTierChange.command.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const id = Subscription.ref("acct_scheduled").id;
const context = Context.make(Actor, system("test"));

const pro = allowance(messages, { included: 100, overage: "bill" });
const small = allowance(messages, { included: 20, overage: "block" });
const lifetime = allowance(messages, { included: 20, overage: "block", resets: "never" });

/** A standing mid-period, using more than the tier it is about to move to. */
const subscribed = (overrides: Partial<SubscribedState> = {}): SubscribedState =>
  ({
    _tag: "Subscribed",
    tier: "pro",
    status: "active",
    period: { start, end: monthLater, anchorTz: "UTC" },
    interval: "month",
    cancelAtPeriodEnd: false,
    credits: 0,
    creditsExpire: "period",
    rates: {},
    currency: "usd",
    usage: { messages: 60 },
    remaining: { messages: 40 },
    holds: {},
    allowances: { messages: pro },
    refs: {},
    trialUsed: true,
    dedupeKeys: {},
    dunningAttempts: 0,
    ...overrides,
  }) as never;

const schedule = () =>
  new ScheduleTierChange({
    tier: "small",
    allowances: { messages: small },
    credits: 0,
    creditsExpire: "period",
    rates: {},
  });

describe("a tier change scheduled for the boundary", () => {
  it("is recorded on the standing, not applied now", () => {
    const verdict = Subscription.predict(subscribed(), schedule(), { id, now: start, context });
    expect(verdict._tag).toBe("Accepted");
    if (verdict._tag !== "Accepted") return;
    expect(verdict.events).toHaveLength(1);
    expect(verdict.events[0]).toBeInstanceOf(TierChangeScheduled);
    expect(verdict.events[0]).toMatchObject({ tier: "small", allowances: { messages: small } });
  });

  it("lands at the close, before the counters reset onto the new allowances", () => {
    const state = subscribed({
      pendingTier: {
        tier: "small",
        allowances: { messages: small },
        credits: 0,
        creditsExpire: "period",
        rates: {},
        currency: "usd",
        interval: "month",
      },
    });
    const verdict = Subscription.predict(
      state,
      new ClosePeriod({
        periodEnd: state.period.end,
        input: { periodEnd: state.period.end },
      } as never),
      { id, now: monthLater, context },
    );
    expect(verdict._tag).toBe("Accepted");
    if (verdict._tag !== "Accepted") return;

    const tags = verdict.events.map((event) => event._tag);
    // The change first: `UsageReset` reads the allowances in state, so a reset
    // emitted ahead of it would start the period on the tier being left.
    expect(tags.indexOf("TierChanged")).toBe(0);
    expect(tags).toContain("PeriodClosed");

    const [changed] = verdict.events as ReadonlyArray<{ _tag: string; allowances?: unknown }>;
    expect(changed?.allowances).toEqual({ messages: small });

    const reset = verdict.events.find((event) => event._tag === "UsageReset");
    // The new tier's included count, not the old one and not the usage carried
    // across a boundary it was never part of.
    expect(reset).toMatchObject({ remaining: { messages: 20 } });
  });

  it("refuses to schedule for an account with no standing", () => {
    const verdict = Subscription.predict({ _tag: "Unsubscribed", refs: {} } as never, schedule(), {
      id,
      now: start,
      context,
    });
    expect(verdict._tag).toBe("Rejected");
  });
});

describe("withdrawing a scheduled tier change", () => {
  const pendingAt = (tier = "small", allowance = small): Partial<SubscribedState> => ({
    pendingTier: {
      tier,
      allowances: { messages: allowance },
      credits: 0,
      creditsExpire: "period",
      rates: {},
      currency: "usd",
      interval: "month",
    },
  });

  it("records the intent it abandoned and leaves the standing where it is", () => {
    const state = subscribed(pendingAt());
    const verdict = Subscription.predict(state, new WithdrawTierChange(), {
      id,
      now: start,
      context,
    });
    expect(verdict._tag).toBe("Accepted");
    if (verdict._tag !== "Accepted") return;
    expect(verdict.events).toHaveLength(1);
    // The log keeps which change was abandoned: a second schedule overwrites the
    // first without an event, so the event is the only record of an intent that
    // was dropped rather than replaced.
    expect(verdict.events[0]).toBeInstanceOf(TierChangeWithdrawn);
    expect(verdict.events[0]).toMatchObject({ tier: "small" });

    const after = verdict.state as SubscribedState;
    expect(after.pendingTier).toBeUndefined();
    // Nothing else moved: same tier, same counters, same period.
    expect(after.tier).toBe(state.tier);
    expect(after.usage).toEqual(state.usage);
    expect(after.remaining).toEqual(state.remaining);
    expect(after.period).toEqual(state.period);
  });

  it("then closes the period on the tier the account is on", () => {
    const state = subscribed(pendingAt());
    const verdict = Subscription.predict(state, new WithdrawTierChange(), {
      id,
      now: start,
      context,
    });
    expect(verdict._tag).toBe("Accepted");
    if (verdict._tag !== "Accepted") return;

    const closed = Subscription.predict(
      verdict.state as SubscribedState,
      new ClosePeriod({
        periodEnd: state.period.end,
        input: { periodEnd: state.period.end },
      } as never),
      { id, now: monthLater, context },
    );
    expect(closed._tag).toBe("Accepted");
    if (closed._tag !== "Accepted") return;
    // No `TierChanged`: the withdrawn schedule does not land at the boundary.
    expect(closed.events.map((event) => event._tag)).not.toContain("TierChanged");
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
  const withTier = (over: {
    readonly allowances?: Record<string, unknown>;
    readonly price?: { amount: number; currency: string; interval: "month" | "annual" };
  }) =>
    new ScheduleTierChange({
      tier: "pack",
      allowances: (over.allowances ?? { messages: small }) as never,
      credits: 1_000,
      creditsExpire: "never",
      rates: {},
      ...(over.price === undefined ? {} : { price: over.price }),
    });

  it("an empty grant: that is a one-off pack, not a tier", () => {
    // A pack has no allowances, and the close would apply those terms verbatim:
    // the standing would lose every allowance and take the pack's credits as its
    // pool, having paid for a pack rather than a plan.
    const verdict = Subscription.predict(subscribed(), withTier({ allowances: {} }), {
      id,
      now: start,
      context,
    });
    expect(verdict._tag).toBe("Rejected");
    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(TierNotInCatalog);
  });

  it("a price in another currency than the standing's", () => {
    const verdict = Subscription.predict(
      subscribed(),
      withTier({ price: { amount: 1_900, currency: "eur", interval: "month" } }),
      { id, now: start, context },
    );
    expect(verdict._tag).toBe("Rejected");
    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(CurrencyMismatch);
  });
});

describe("the pool at the boundary", () => {
  const monthly = {
    tier: "monthly",
    allowances: { messages: small },
    credits: 500,
    creditsExpire: "period" as const,
    rates: {},
    currency: "usd",
    interval: "month" as const,
  };

  const close = (state: SubscribedState) =>
    Subscription.predict(
      state,
      new ClosePeriod({
        periodEnd: state.period.end,
        input: { periodEnd: state.period.end },
      } as never),
      { id, now: monthLater, context },
    );

  it("grants the new tier's pool and expires it by the new tier's rule", () => {
    // The account is on a pool that does not expire and moves to one that does.
    // The boundary is a new period, so it grants the new tier's credits and then
    // expires them: reading the rule off the tier being left would keep a pool
    // no period ever clears.
    const verdict = close(subscribed({ credits: 0, creditsExpire: "never", pendingTier: monthly }));
    expect(verdict._tag).toBe("Accepted");
    if (verdict._tag !== "Accepted") return;

    const changed = verdict.events.find((event) => event._tag === "TierChanged") as
      | { readonly credits: number }
      | undefined;
    expect(changed?.credits).toBe(500);
    const expired = verdict.events.find((event) => event._tag === "CreditsExpired") as
      | { readonly amount: number; readonly balanceAfter: number }
      | undefined;
    expect(expired).toMatchObject({ amount: 500, balanceAfter: 0 });
    expect((verdict.state as SubscribedState).credits).toBe(0);
  });

  it("keeps what a one-off pack bought, and keeps protecting it", () => {
    // 100 of the 120 in the pool came from a pack. The grant replaces the plan's
    // 20 and the close expires only that part, so the pack is still there and
    // still the pool a close may not take.
    const verdict = close(
      subscribed({
        credits: 120,
        prepaidCredits: 100,
        creditsExpire: "period",
        pendingTier: monthly,
      }),
    );
    expect(verdict._tag).toBe("Accepted");
    if (verdict._tag !== "Accepted") return;

    const changed = verdict.events.find((event) => event._tag === "TierChanged") as
      | { readonly credits: number; readonly prepaidCredits?: number }
      | undefined;
    expect(changed?.credits).toBe(600);
    expect(changed?.prepaidCredits).toBe(100);
    const expired = verdict.events.find((event) => event._tag === "CreditsExpired") as
      | { readonly amount: number; readonly balanceAfter: number }
      | undefined;
    expect(expired).toMatchObject({ amount: 500, balanceAfter: 100 });

    const after = verdict.state as SubscribedState;
    expect(after.credits).toBe(100);
    expect(after.prepaidCredits).toBe(100);
  });

  it("expires nothing when the tier it moves to keeps its pool", () => {
    const verdict = close(
      subscribed({
        credits: 40,
        creditsExpire: "period",
        pendingTier: { ...monthly, creditsExpire: "never" },
      }),
    );
    expect(verdict._tag).toBe("Accepted");
    if (verdict._tag !== "Accepted") return;
    expect(verdict.events.map((event) => event._tag)).not.toContain("CreditsExpired");
    expect((verdict.state as SubscribedState).credits).toBe(500);
  });
});

it("starts every counter over, including a resets:never one", () => {
  // The account used 60 units on `pro` and scheduled a move to a tier whose
  // allowance never resets. Keeping that count would be a count against an
  // allowance that never granted those units: the tier changed, so the counter
  // the next period runs on is the new allowance's.
  const state = subscribed({
    pendingTier: {
      tier: "lifetime",
      allowances: { messages: lifetime },
      credits: 0,
      creditsExpire: "period",
      rates: {},
      currency: "usd",
      interval: "month",
    },
  });
  const verdict = Subscription.predict(
    state,
    new ClosePeriod({
      periodEnd: state.period.end,
      input: { periodEnd: state.period.end },
    } as never),
    { id, now: monthLater, context },
  );
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

it("keeps a resets:never count across a close that changes no tier", () => {
  const state = subscribed({
    tier: "lifetime",
    allowances: { messages: lifetime },
  });
  const verdict = Subscription.predict(
    state,
    new ClosePeriod({
      periodEnd: state.period.end,
      input: { periodEnd: state.period.end },
    } as never),
    { id, now: monthLater, context },
  );
  expect(verdict._tag).toBe("Accepted");
  if (verdict._tag !== "Accepted") return;
  const reset = verdict.events.find((event) => event._tag === "UsageReset") as
    | { readonly kept?: Record<string, boolean> }
    | undefined;
  expect(reset?.kept?.messages).toBe(true);
  expect((verdict.state as SubscribedState).usage.messages).toBe(60);
});
