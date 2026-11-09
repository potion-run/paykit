import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { balanceOf, balanceOfFeature } from "../../src/Balance.ts";
import { feature, messages } from "../../src/Feature.ts";
import { ApplyPlanPhase } from "../../src/Subscription/ApplyPlanPhase.command.ts";
import {
  CancelGroup,
  DefaultPlanNotCancelable,
  UncancelGroup,
} from "../../src/Subscription/CancelGroup.command.ts";
import { ChangePlans } from "../../src/Subscription/ChangePlans.command.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import {
  Entitlements,
  initialEntitlements,
  type EntitlementsState,
} from "../../src/Subscription/Entitlements.view.ts";
import { PlanGroupOccupied } from "../../src/Subscription/PlanGroupOccupied.rejection.ts";
import { PlanPhaseAtSameInstant } from "../../src/Subscription/PlanPhaseAtSameInstant.rejection.ts";
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
import { planPhase, planRow, soldPlan } from "../support/Plans.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const id = Subscription.ref("acct_plan_set_multi").id;
const context = Context.make(Actor, system("test"));

const pro = allowance(messages, { included: 100, overage: "bill" });
const support = feature({ id: "support", name: "Support" });
const supportItem = allowance(support, { included: 5, overage: "block" });

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

const predict = (state: SubscribedState, command: { readonly _tag: string }, now = start) =>
  Subscription.predict(state, command as never, {
    id,
    now,
    context,
  }) as ReturnType<typeof Subscription.predict>;

const accepted = (verdict: ReturnType<typeof predict>): SubscribedState => {
  expect(verdict._tag).toBe("Accepted");

  return verdict._tag === "Accepted" ? (verdict.state as SubscribedState) : (undefined as never);
};

describe("multiAttach / multiUpdate", () => {
  it("attaches a second group and an add-on in one transaction", () => {
    const command = new ChangePlans({
      moves: [
        {
          tier: "support",
          group: "support",
          allowances: { support: supportItem },
          credits: 0,
          creditsExpire: "period",
          rates: {},
        },
        {
          tier: "analytics",
          addOn: true,
          allowances: {
            analytics: allowance(feature({ id: "analytics", name: "Analytics" }), { included: 10 }),
          },
          credits: 0,
          creditsExpire: "period",
          rates: {},
        },
      ],
    });

    const verdict = predict(subscribed(), command);
    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    expect(verdict.events.map((event: { readonly _tag: string }) => event._tag)).toEqual([
      "PlanChanged",
      "PlanChanged",
    ]);

    const after = accepted(verdict);
    expect(planRowsOf(after)).toHaveLength(3);
    expect(planOfGroup(after)?.planId).toBe("pro");
    expect(planOfGroup(after, "support")?.planId).toBe("support");
    expect(addOnsOf(after).map((row) => row.planId)).toEqual(["analytics"]);
    expect(Object.keys(allowancesOf(after)).sort()).toEqual(["analytics", "messages", "support"]);
  });

  it("carries a move, a phase and a group cancellation in one transaction", () => {
    const command = new ChangePlans({
      moves: [
        {
          tier: "analytics",
          addOn: true,
          allowances: {
            analytics: allowance(feature({ id: "analytics", name: "Analytics" }), { included: 10 }),
          },
          credits: 0,
          creditsExpire: "period",
          rates: {},
        },
        {
          tier: "scale",
          allowances: { messages: allowance(messages, { included: 40 }) },
          credits: 0,
          creditsExpire: "period",
          rates: {},
          at: monthLater,
        },
      ],
      cancels: [{ group: "support" }],
    });

    const verdict = predict(
      subscribed({
        plans: {
          ...soldPlan("pro", { allowances: { messages: pro } }),
          ...soldPlan("support", { group: "support", allowances: { support: supportItem } }),
        },
      }),
      command,
    );

    expect(verdict._tag).toBe("Accepted");

    if (verdict._tag !== "Accepted") return;
    expect(verdict.events.map((event: { readonly _tag: string }) => event._tag)).toEqual([
      "PlanChanged",
      "PlanChangeScheduled",
      "GroupCancellationScheduled",
    ]);

    const after = verdict.state as SubscribedState;
    expect(planOfGroup(after, "support")?.planId).toBe("support");
    expect(addOnsOf(after).map((row) => row.planId)).toEqual(["analytics"]);
    expect(scheduleOf(after).map((phase) => phase.planId)).toEqual(["scale"]);
    expect(after.cancellations?.support?.planId).toBe("support");
  });

  it("refuses the whole operation when two moves name one group", () => {
    const command = new ChangePlans({
      moves: [
        {
          tier: "pro",
          allowances: { messages: pro },
          credits: 0,
          creditsExpire: "period",
          rates: {},
        },
        {
          tier: "scale",
          allowances: { messages: pro },
          credits: 0,
          creditsExpire: "period",
          rates: {},
        },
      ],
    });

    const verdict = predict(subscribed(), command);
    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(PlanGroupOccupied);
  });

  it("refuses two phases at one instant, and records none of the moves", () => {
    const command = new ChangePlans({
      moves: [
        {
          tier: "support",
          group: "support",
          allowances: { support: supportItem },
          credits: 0,
          creditsExpire: "period",
          rates: {},
          at: monthLater,
        },
        {
          tier: "scale",
          allowances: { messages: pro },
          credits: 0,
          creditsExpire: "period",
          rates: {},
          at: monthLater,
        },
      ],
    });

    const verdict = predict(subscribed(), command);
    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(PlanPhaseAtSameInstant);
  });
});

describe("one balance source per plan", () => {
  it("reports a plan row per plan that grants the feature", () => {
    const balance = balanceOfFeature("acct", "messages", {
      included: 150,
      remaining: 150,
      overage: "bill",
      resets: "month",
      resetsAt: null,
      planSources: [
        { planId: "pro", included: 100, resets: "month" },
        { planId: "extra", included: 50, resets: "month" },
      ],
    });

    expect(balance.breakdown.map((row) => row.planId)).toEqual(["pro", "extra"]);
    expect(balance.breakdown.map((row) => row.granted)).toEqual([100, 50]);
    expect(balance.breakdown.every((row) => row.kind === "plan")).toBe(true);
  });

  it("threads the plan set through the entitlement read", () => {
    const handlers = Entitlements.definition.evolve as unknown as Record<
      string,
      (state: EntitlementsState, event: unknown, context: unknown) => EntitlementsState
    >;

    const at = { key: { id: "acct" } };

    const base = {
      tier: "pro",
      allowances: { messages: pro },
      rates: {},
      credits: 0,
      creditsExpire: "period" as const,
      periodStart: start,
      periodEnd: monthLater,
      anchorTz: "UTC",
      interval: "month" as const,
      currency: "usd",
      remaining: { messages: 100 },
      statusAfter: "active" as const,
    };

    const activated = handlers.SubscriptionActivated!(
      initialEntitlements,
      { _tag: "SubscriptionActivated", ...base },
      at,
    );

    const withAddOn = handlers.PlanChanged!(
      activated,
      {
        _tag: "PlanChanged",
        tier: "extra",
        addOn: true,
        allowances: { messages: allowance(messages, { included: 50 }) },
        rates: {},
        credits: 0,
        creditsExpire: "period",
        remaining: { messages: 50 },
      },
      at,
    );

    const balance = balanceOf(withAddOn, "messages");
    expect(balance?.breakdown.map((row) => row.planId)).toEqual(["pro", "extra"]);
    expect(balance?.granted).toBe(150);
  });
});

describe("cancelGroup / uncancelGroup", () => {
  const twoGroups = () =>
    subscribed({
      plans: {
        ...soldPlan("pro", { allowances: { messages: pro } }),
        ...soldPlan("support", {
          group: "support",
          allowances: { support: supportItem },
        }),
      },
      schedule: [
        planPhase("support-plus", monthLater, {
          group: "support",
          allowances: { support: supportItem },
        }),
      ],
    });

  it("cancels one group to its default and leaves the other group running", () => {
    const verdict = predict(
      twoGroups(),
      new CancelGroup({
        group: "support",
        fallback: planRow("support-free", {
          group: "support",
          allowances: { support: supportItem },
        }),
      }),
    );

    const after = accepted(verdict);
    expect(planOfGroup(after, "support")?.planId).toBe("support");
    expect(scheduleOf(after)).toHaveLength(0);
    expect(after.cancellations?.support?.planId).toBe("support");

    const closed = predict(
      after,
      new ClosePeriod({
        periodEnd: monthLater,
        input: { periodEnd: monthLater },
      } as never),
      monthLater,
    );

    const boundary = accepted(closed);
    expect(planOfGroup(boundary, "support")?.planId).toBe("support-free");
    expect(planOfGroup(boundary)?.planId).toBe("pro");
    expect(boundary.status).toBe("active");
  });

  it("refuses to cancel the group's default plan", () => {
    const verdict = predict(
      subscribed(),
      new CancelGroup({
        group: "default",
        fallback: planRow("pro"),
      }),
    );

    expect(verdict._tag).toBe("Rejected");

    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(DefaultPlanNotCancelable);
  });

  it("leaves a group with no default empty, and ends the account when that was the last plan", () => {
    const state = subscribed({
      plans: {
        ...soldPlan("pro", { allowances: { messages: pro } }),
        ...soldPlan("support", {
          group: "support",
          allowances: { support: supportItem },
        }),
      },
    });

    const canceledSupport = accepted(predict(state, new CancelGroup({ group: "support" })));

    const uncanceledSupport = accepted(
      predict(canceledSupport, new UncancelGroup({ group: "support" })),
    );

    expect(canceledSupport.cancellations?.support?.planId).toBe("support");
    expect(uncanceledSupport.cancellations?.support).toBeUndefined();

    const canceledBoth = accepted(
      predict(
        accepted(predict(uncanceledSupport, new CancelGroup({ group: "default" }))),
        new CancelGroup({ group: "support" }),
      ),
    );

    const closed = accepted(
      predict(
        canceledBoth,
        new ClosePeriod({
          periodEnd: monthLater,
          input: { periodEnd: monthLater },
        } as never),
        monthLater,
      ),
    );

    expect(closed.status).toBe("canceled");
    expect(planRowsOf(closed)).toHaveLength(0);
  });
});

describe("the phase fires at its own instant", () => {
  it("applies the named phase and records nothing for a stale deadline", () => {
    const state = subscribed({
      schedule: [
        planPhase("small", monthLater, {
          allowances: { messages: allowance(messages, { included: 20 }) },
        }),
      ],
    });

    const stale = predict(state, new ApplyPlanPhase({ planId: "small", at: start }), monthLater);
    expect(stale._tag).toBe("Accepted");

    if (stale._tag !== "Accepted") return;
    expect(stale.events).toHaveLength(0);

    const applied = accepted(
      predict(state, new ApplyPlanPhase({ planId: "small", at: monthLater }), monthLater),
    );

    expect(planIdOf(applied)).toBe("small");
    expect(scheduleOf(applied)).toHaveLength(0);
    expect(applied.lastPhaseAppliedAt).toEqual(monthLater);
  });

  it("lets the close reset onto the plan the deadline applied, once", () => {
    const state = subscribed({
      plans: soldPlan("pro", { allowances: { messages: pro }, credits: 10 }),
      credits: 10,
      schedule: [
        planPhase("small", monthLater, {
          allowances: { messages: allowance(messages, { included: 20 }) },
          credits: 30,
        }),
      ],
    });

    const applied = accepted(
      predict(state, new ApplyPlanPhase({ planId: "small", at: monthLater }), monthLater),
    );

    const closed = predict(
      applied,
      new ClosePeriod({
        periodEnd: monthLater,
        input: { periodEnd: monthLater },
      } as never),
      monthLater,
    );

    expect(closed._tag).toBe("Accepted");

    if (closed._tag !== "Accepted") return;
    expect(
      closed.events.filter((event: { readonly _tag: string }) => event._tag === "PlanChanged"),
    ).toHaveLength(0);

    const after = closed.state as SubscribedState;
    expect(planIdOf(after)).toBe("small");
    expect(after.credits).toBe(30);
    expect(after.remaining.messages).toBe(20);
  });
});
