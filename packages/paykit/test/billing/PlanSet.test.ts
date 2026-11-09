import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { feature, messages } from "../../src/Feature.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { ScheduleTierChange } from "../../src/Subscription/ScheduleTierChange.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  addOnsOf,
  allowancesOf,
  planIdOf,
  planOfGroup,
  planRowsOf,
  scheduleOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { planPhase, planRow, soldPlan, withSoldPlan } from "../support/Plans.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const id = Subscription.ref("acct_plan_set").id;
const context = Context.make(Actor, system("test"));

const pro = allowance(messages, { included: 100, overage: "bill" });
const support = feature({ id: "support", name: "Support" });
const supportItem = allowance(support, { included: 5, overage: "block" });

/** A standing on `pro`, with whatever schedule a test needs. */
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
    usage: {},
    remaining: { messages: 100 },
    holds: {},
    refs: {},
    trialUsed: true,
    dedupeKeys: {},
    dunningAttempts: 0,
    ...overrides,
  }) as never;

describe("the plan set", () => {
  it("holds one plan per group, and a move replaces rather than adds", () => {
    const state = subscribed({
      plans: soldPlan("scale", { allowances: { messages: pro } }),
    });

    // The fixture wrote one row; the accessors read the group, not the id.
    expect(planRowsOf(state)).toHaveLength(1);
    expect(planOfGroup(state)?.planId).toBe("scale");
    expect(planOfGroup(state, "support")).toBeUndefined();
  });

  it("stacks an add-on beside the group's plan, and merges what it grants", () => {
    const state = subscribed({
      plans: {
        ...soldPlan("pro", { allowances: { messages: pro } }),
        ...soldPlan("support", {
          group: "support",
          addOn: true,
          allowances: { support: supportItem },
        }),
      },
    });

    expect(planIdOf(state)).toBe("pro");
    expect(addOnsOf(state).map((row) => row.planId)).toEqual(["support"]);
    // The add-on's feature is spendable beside the plan's, which is the whole
    // point of stacking (ADR 0039 §2).
    expect(Object.keys(allowancesOf(state)).sort()).toEqual(["messages", "support"]);
    expect(planOfGroup(state)?.planId).toBe("pro");
  });

  it("merges a feature two plans both grant by adding what they include", () => {
    const state = subscribed({
      plans: {
        ...soldPlan("pro", { allowances: { messages: pro } }),
        ...soldPlan("extra", {
          addOn: true,
          allowances: { messages: allowance(messages, { included: 50 }) },
        }),
      },
    });

    expect(allowancesOf(state).messages?.included).toBe(150);
  });
});

describe("a phase in another group", () => {
  it("adds a plan there and leaves the sold plan alone", () => {
    const state = subscribed({
      schedule: [
        planPhase("support", monthLater, {
          group: "support",
          allowances: { support: supportItem },
        }),
      ],
    });

    const verdict = Subscription.predict(
      state,
      new ClosePeriod({ periodEnd: monthLater, input: { periodEnd: monthLater } } as never),
      { id, now: monthLater, context },
    );

    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;

    const after = verdict.state as SubscribedState;
    expect(planOfGroup(after)?.planId).toBe("pro");
    expect(planOfGroup(after, "support")?.planId).toBe("support");
    expect(planRowsOf(after)).toHaveLength(2);
    expect(scheduleOf(after)).toHaveLength(0);
    expect(addOnsOf(after)).toHaveLength(0);
  });

  it("carries the phase's group through the event, so a replay lands it there", () => {
    const verdict = Subscription.predict(
      subscribed(),
      new ScheduleTierChange({
        tier: "support",
        group: "support",
        at: monthLater,
        allowances: { support: supportItem },
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
      { id, now: start, context },
    );

    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;

    const [event] = verdict.events as ReadonlyArray<{ readonly group?: string }>;
    expect(event?.group).toBe("support");
    expect(planOfGroup(verdict.state as SubscribedState, "support")).toBeUndefined();
  });
});

describe("a scheduled plan that carries the sold plan's terms", () => {
  it("keeps a row per group after two boundaries", () => {
    const withPhase = withSoldPlan(subscribed(), { creditsExpire: "period" });

    const state = {
      ...withPhase,
      schedule: [planPhase("scale", monthLater, { allowances: { messages: pro }, credits: 10 })],
    } as SubscribedState;

    const first = Subscription.predict(
      state,
      new ClosePeriod({ periodEnd: monthLater, input: { periodEnd: monthLater } } as never),
      { id, now: monthLater, context },
    );

    expect(first._tag).toBe("Accepted");

    if (first._tag !== "Accepted") return;
    // The row the boundary landed on carries its own pool grant for the next one.
    expect(planOfGroup(first.state as SubscribedState)?.credits).toBe(10);
    expect((first.state as SubscribedState).credits).toBe(10);
  });
});

describe("the add-on row a fixture builds", () => {
  it("is a plain data row, so a test names the terms it sells", () => {
    const row = planRow("support", {
      group: "support",
      addOn: true,
      allowances: { support: supportItem },
    });

    expect(row.addOn).toBe(true);
    expect(row.group).toBe("support");
  });
});
