import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { messages } from "../../src/Feature.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import {
  ScheduleTierChange,
  TierChangeScheduled,
} from "../../src/Subscription/ScheduleTierChange.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { SubscribedState } from "../../src/Subscription/Subscription.state.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const id = Subscription.ref("acct_scheduled").id;
const context = Context.make(Actor, system("test"));

const pro = allowance(messages, { included: 100, overage: "bill" });
const small = allowance(messages, { included: 20, overage: "block" });

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
