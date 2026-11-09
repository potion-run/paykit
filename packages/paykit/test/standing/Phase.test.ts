import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import {
  STANDING_PHASE_EDGES,
  STANDING_PHASE_TRANSITIONS,
  STANDING_TRANSITIONS,
  isStandingPhaseEdge,
  nextStandingPhase,
  standingConditionsOf,
  standingPhaseOf,
  standingTransitionOf,
  type StandingPhaseTag,
  type StandingTransition,
} from "../../src/Subscription/StandingPhase.ts";
import { initialSubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import {
  Script,
  type CommandPlan,
  type ScriptStep,
  commandOf,
  decideAt,
  evolveAt,
  isAccepted,
  start,
  subscribedAt,
  walk,
} from "../properties/Arbitraries.ts";
import { assertProperty } from "../support/Property.ts";

const step = (command: CommandPlan, advanceDays = 0): ScriptStep => ({ command, advanceDays });
const script = (...steps: ReadonlyArray<ScriptStep>): Script => ({ steps });
const monthLater = DateTime.add(start, { months: 1 });

const edgesOf = (
  history: Script,
): ReadonlyArray<readonly [StandingPhaseTag, StandingPhaseTag, StandingTransition]> => {
  let state = initialSubscriptionState;
  let now = start;
  const edges: Array<readonly [StandingPhaseTag, StandingPhaseTag, StandingTransition]> = [];

  for (const [index, entry] of history.steps.entries()) {
    now = DateTime.add(now, { days: entry.advanceDays });
    const before = standingPhaseOf(state, now)._tag;
    const command = commandOf(entry.command, state, now);
    const transition = standingTransitionOf(command, state);
    const decision = decideAt(state, command, now, `phase-${index}`);

    if (!isAccepted(decision) || decision.length === 0) continue;
    state = evolveAt(state, decision, now, `phase-${index}`);
    edges.push([before, standingPhaseOf(state, now)._tag, transition]);
  }

  return edges;
};

describe("standingPhaseOf", () => {
  it("names the phase from the standing and the clock", () => {
    expect(standingPhaseOf(initialSubscriptionState, start)).toEqual({ _tag: "Unsubscribed" });
    expect(standingPhaseOf(subscribedAt("free"), start)).toEqual({
      _tag: "Active",
      deadline: monthLater,
      overdue: false,
    });
    // The period has ended, but no `PeriodEnded` has recorded the close.
    expect(standingPhaseOf(subscribedAt("free"), monthLater)).toEqual({
      _tag: "Active",
      deadline: monthLater,
      overdue: true,
    });
  });

  it("keeps a trial and its deadline until the close lands", () => {
    const trial = walk(script(step({ _tag: "StartTrial", tier: "free", trialDays: 10 }))).state;
    const deadline = DateTime.add(start, { days: 10 });
    expect(standingPhaseOf(trial, start)).toEqual({
      _tag: "Trialing",
      deadline,
      overdue: false,
    });
    expect(standingPhaseOf(trial, DateTime.add(deadline, { days: 1 }))).toEqual({
      _tag: "Trialing",
      deadline,
      overdue: true,
    });
  });

  it("shows grace past its deadline before GraceElapsed runs", () => {
    const grace = walk(
      script(step({ _tag: "Subscribe", tier: "free" }), step({ _tag: "EnterGrace" })),
    ).state;

    const deadline = DateTime.add(start, { days: 7 });
    expect(standingPhaseOf(grace, start)).toEqual({
      _tag: "Grace",
      deadline,
      overdue: false,
    });
    expect(standingPhaseOf(grace, deadline)).toEqual({
      _tag: "Grace",
      deadline,
      overdue: true,
    });
  });

  it("recognises the terminal phases", () => {
    const expired = walk(
      script(
        step({ _tag: "Subscribe", tier: "free" }),
        step({ _tag: "EnterGrace" }),
        step({ _tag: "Expire" }),
      ),
    ).state;

    const canceled = walk(
      script(
        step({ _tag: "Subscribe", tier: "free" }),
        step({ _tag: "ScheduleCancellation" }),
        step({ _tag: "PeriodEnded" }, 40),
      ),
    ).state;

    expect(standingPhaseOf(expired, start)).toEqual({ _tag: "Expired" });
    expect(standingPhaseOf(canceled, DateTime.add(start, { days: 40 }))).toEqual({
      _tag: "Canceled",
    });
  });
});

describe("standingConditionsOf", () => {
  it("folds the orthogonal state into one record", () => {
    expect(standingConditionsOf(subscribedAt("free"), start)).toEqual({
      trialUsed: false,
      cancelAtPeriodEnd: false,
      pendingTier: null,
      topUpCooldown: "none",
      openHolds: 0,
      lapsedHolds: 0,
      proration: "none",
      unplannedCredits: 0,
    });
  });

  it("keeps a pack bought before any plan visible", () => {
    const unplanned = { ...initialSubscriptionState, credits: 250 };
    expect(standingConditionsOf(unplanned, start).unplannedCredits).toBe(250);
    expect(standingPhaseOf(unplanned, start)._tag).toBe("Unsubscribed");
  });

  it("reports a lifetime trial latch, a scheduled cancellation and a pending tier", () => {
    const trial = walk(script(step({ _tag: "StartTrial", tier: "free", trialDays: 10 }))).state;
    expect(standingConditionsOf(trial, start).trialUsed).toBe(true);

    const canceledAtBoundary = walk(
      script(step({ _tag: "Subscribe", tier: "free" }), step({ _tag: "ScheduleCancellation" })),
    ).state;

    expect(standingConditionsOf(canceledAtBoundary, start).cancelAtPeriodEnd).toBe(true);

    const scheduled = {
      ...subscribedAt("free"),
      schedule: [
        {
          planId: "pro",
          version: 1,
          group: "default",
          addOn: false,
          at: start,
          allowances: {},
          credits: 0,
          creditsExpire: "period" as const,
          rates: {},
        },
      ],
    };

    expect(standingConditionsOf(scheduled, start).pendingTier).toBe("pro");
  });

  it("separates an open cooldown from one whose deadline has passed", () => {
    const open = {
      ...subscribedAt("free"),
      topUpCooldownUntil: DateTime.add(start, { hours: 1 }),
    };

    expect(standingConditionsOf(open, start).topUpCooldown).toBe("open");
    expect(standingConditionsOf(open, DateTime.add(start, { hours: 2 })).topUpCooldown).toBe(
      "lapsed",
    );
    expect(standingConditionsOf(subscribedAt("free"), start).topUpCooldown).toBe("none");
  });

  it("counts an open hold and the subset whose deadline has passed", () => {
    const held = (expiresAt: DateTime.Utc) => {
      const state = subscribedAt("free");

      const command = new Hold({
        holdId: "hold-phase",
        feature: "messages",
        amount: 10,
        expiresAt,
      });

      const decision = decideAt(state, command, start, "hold-phase");

      if (!isAccepted(decision)) throw new Error("the fixture could not hold");

      return evolveAt(state, decision, start, "hold-phase");
    };

    const early = held(DateTime.add(start, { hours: 1 }));
    expect(standingConditionsOf(early, start)).toMatchObject({
      openHolds: 1,
      lapsedHolds: 0,
    });
    expect(standingConditionsOf(early, DateTime.add(start, { hours: 2 }))).toMatchObject({
      openHolds: 1,
      lapsedHolds: 1,
    });

    const late = held(start);
    expect(standingConditionsOf(late, start)).toMatchObject({
      openHolds: 1,
      lapsedHolds: 1,
    });
  });

  it("names owed, billed and credit prorations", () => {
    const proration = { currency: "usd", credit: 0, charge: 100, due: 100 };
    const base = subscribedAt("free");
    expect(standingConditionsOf({ ...base, proration }, start).proration).toBe("owed");
    expect(
      standingConditionsOf({ ...base, proration, prorationInvoice: "in_phase" }, start).proration,
    ).toBe("billed");
    expect(
      standingConditionsOf({ ...base, proration: { ...proration, due: -100 } }, start).proration,
    ).toBe("credit");
  });
});

interface PhaseEdgeCase {
  readonly edge: readonly [StandingPhaseTag, StandingPhaseTag];
  readonly steps: Script;
}

const cases: ReadonlyArray<PhaseEdgeCase> = [
  {
    edge: ["Unsubscribed", "Unsubscribed"],
    steps: script(step({ _tag: "PurchaseCredits", amount: 10 })),
  },
  {
    edge: ["Unsubscribed", "Trialing"],
    steps: script(step({ _tag: "StartTrial", tier: "free", trialDays: 10 })),
  },
  {
    edge: ["Unsubscribed", "Active"],
    steps: script(step({ _tag: "Subscribe", tier: "free" })),
  },
  {
    edge: ["Trialing", "Trialing"],
    steps: script(
      step({ _tag: "StartTrial", tier: "free", trialDays: 10 }),
      step({ _tag: "ExtendTrial", trialDays: 15 }),
    ),
  },
  {
    edge: ["Trialing", "Active"],
    steps: script(
      step({ _tag: "StartTrial", tier: "free", trialDays: 10 }),
      step({ _tag: "PeriodEnded" }, 40),
    ),
  },
  {
    edge: ["Trialing", "Grace"],
    steps: script(
      step({ _tag: "StartTrial", tier: "free", trialDays: 10 }),
      step({ _tag: "EnterGrace" }),
    ),
  },
  {
    edge: ["Trialing", "Canceled"],
    steps: script(
      step({ _tag: "StartTrial", tier: "free", trialDays: 10 }),
      step({ _tag: "ScheduleCancellation" }),
      step({ _tag: "PeriodEnded" }, 40),
    ),
  },
  {
    edge: ["Active", "Active"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "TrackUsage", amount: 10 }),
    ),
  },
  {
    edge: ["Active", "Trialing"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "StartTrial", tier: "pro", trialDays: 10 }),
    ),
  },
  {
    edge: ["Active", "Grace"],
    steps: script(step({ _tag: "Subscribe", tier: "free" }), step({ _tag: "EnterGrace" })),
  },
  {
    edge: ["Active", "Canceled"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "ScheduleCancellation" }),
      step({ _tag: "PeriodEnded" }, 40),
    ),
  },
  {
    edge: ["Grace", "Grace"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "EnterGrace" }),
      step({ _tag: "RecordPaymentFailure" }),
    ),
  },
  {
    edge: ["Grace", "Active"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "EnterGrace" }),
      step({ _tag: "Recover" }),
    ),
  },
  {
    edge: ["Grace", "Trialing"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "EnterGrace" }),
      step({ _tag: "StartTrial", tier: "pro", trialDays: 10 }),
    ),
  },
  {
    edge: ["Grace", "Canceled"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "EnterGrace" }),
      step({ _tag: "ScheduleCancellation" }),
      step({ _tag: "PeriodEnded" }, 40),
    ),
  },
  {
    edge: ["Grace", "Expired"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "EnterGrace" }),
      step({ _tag: "Expire" }),
    ),
  },
  {
    edge: ["Expired", "Expired"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "EnterGrace" }),
      step({ _tag: "Expire" }),
      step({ _tag: "GrantCredits", amount: 10 }),
    ),
  },
  {
    edge: ["Expired", "Trialing"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "EnterGrace" }),
      step({ _tag: "Expire" }),
      step({ _tag: "StartTrial", tier: "pro", trialDays: 10 }),
    ),
  },
  {
    edge: ["Expired", "Active"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "EnterGrace" }),
      step({ _tag: "Expire" }),
      step({ _tag: "Subscribe", tier: "pro" }),
    ),
  },
  {
    edge: ["Canceled", "Canceled"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "ScheduleCancellation" }),
      step({ _tag: "PeriodEnded" }, 40),
      step({ _tag: "GrantCredits", amount: 10 }),
    ),
  },
  {
    edge: ["Canceled", "Trialing"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "ScheduleCancellation" }),
      step({ _tag: "PeriodEnded" }, 40),
      step({ _tag: "StartTrial", tier: "pro", trialDays: 10 }),
    ),
  },
  {
    edge: ["Canceled", "Active"],
    steps: script(
      step({ _tag: "Subscribe", tier: "free" }),
      step({ _tag: "ScheduleCancellation" }),
      step({ _tag: "PeriodEnded" }, 40),
      step({ _tag: "Subscribe", tier: "pro" }),
    ),
  },
];

const tags: ReadonlyArray<StandingPhaseTag> = [
  "Unsubscribed",
  "Trialing",
  "Active",
  "Grace",
  "Expired",
  "Canceled",
];

describe("standingTransitionOf", () => {
  it("classifies a close by the standing's cancellation flag, and everything else by tag", () => {
    const active = subscribedAt("free");
    expect(standingTransitionOf({ _tag: "PeriodEnded" }, active)).toBe("close");
    expect(
      standingTransitionOf({ _tag: "PeriodEnded" }, { ...active, cancelAtPeriodEnd: true }),
    ).toBe("cancelAtBoundary");
    expect(standingTransitionOf({ _tag: "StartTrial" }, active)).toBe("trial");
    expect(standingTransitionOf({ _tag: "GrantCredits" }, active)).toBe("other");
  });
});

describe("STANDING_PHASE_TRANSITIONS", () => {
  it("is total: every phase answers every move", () => {
    for (const phase of tags) {
      for (const transition of STANDING_TRANSITIONS) {
        expect(tags).toContain(STANDING_PHASE_TRANSITIONS[phase][transition]);
      }
    }
  });

  it("has an annotated edge for every pair the table can reach, and no extras", () => {
    const fromTable = new Set(
      Object.entries(STANDING_PHASE_TRANSITIONS).flatMap(([from, row]) =>
        Object.values(row).map((to) => `${from}->${to}`),
      ),
    );

    const fromEdges = STANDING_PHASE_EDGES.map((edge) => `${edge.from}->${edge.to}`);
    expect(new Set(fromEdges).size).toBe(fromEdges.length);
    expect([...fromTable].sort()).toEqual([...fromEdges].sort());

    for (const phase of tags) expect(isStandingPhaseEdge(phase, phase)).toBe(true);
  });

  it("is exactly the set of edges decide can walk", () => {
    const observed = new Set<string>();

    for (const testCase of cases) {
      const walked = edgesOf(testCase.steps);
      const last = walked.at(-1);
      expect(last === undefined ? null : [last[0], last[1]]).toEqual(testCase.edge);

      for (const [from, to, transition] of walked) {
        expect(nextStandingPhase(from, transition)).toBe(to);
        expect(isStandingPhaseEdge(from, to)).toBe(true);
        observed.add(`${from}->${to}`);
      }
    }

    expect([...observed].sort()).toEqual(
      STANDING_PHASE_EDGES.map((edge) => `${edge.from}->${edge.to}`).sort(),
    );
  });

  it.effect("holds a generated script to the same table", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (history) => {
        let state = initialSubscriptionState;
        let now = start;

        for (const [index, entry] of history.steps.entries()) {
          now = DateTime.add(now, { days: entry.advanceDays });
          const before = standingPhaseOf(state, now)._tag;
          const command = commandOf(entry.command, state, now);
          const transition = standingTransitionOf(command, state);
          const decision = decideAt(state, command, now, `generated-${index}`);

          if (!isAccepted(decision)) {
            if (standingPhaseOf(state, now)._tag !== before) return false;
            continue;
          }

          // An accepted command that records nothing is not a move: an early
          // `PeriodEnded` and a repeat `Expire` leave the phase where it was.
          if (decision.length === 0) {
            if (standingPhaseOf(state, now)._tag !== before) return false;
            continue;
          }

          state = evolveAt(state, decision, now, `generated-${index}`);

          if (nextStandingPhase(before, transition) !== standingPhaseOf(state, now)._tag) {
            return false;
          }
        }

        return true;
      },
      { runs: 60, size: 40 },
    ),
  );
});
