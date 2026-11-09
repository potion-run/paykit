import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import {
  HOLD_STATUS_TRANSITIONS,
  HOLD_TRANSITIONS,
  holdTransitionOf,
  nextHoldStatus,
  type HoldTransition,
} from "../../src/Subscription/HoldPhase.ts";
import {
  STANDING_PHASE_EDGES,
  STANDING_PHASE_TRANSITIONS,
  STANDING_TRANSITIONS,
  StandingPhaseTag,
  isStandingPhaseEdge,
  nextStandingPhase,
  standingPhaseEdge,
  standingTransitionOf,
  type StandingTransition,
} from "../../src/Subscription/StandingPhase.ts";
import {
  HoldStatus,
  initialSubscriptionState,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import { subscribedAt } from "./Arbitraries.ts";

/** Every move the hold table has a column for. */
const HoldMove = Schema.Literals(HOLD_TRANSITIONS);

/** Every move the standing table has a column for. */
const StandingMove = Schema.Literals(STANDING_TRANSITIONS);

const HoldStep = Schema.Struct({
  status: HoldStatus,
  transition: HoldMove,
});

const StandingStep = Schema.Struct({
  phase: StandingPhaseTag,
  transition: StandingMove,
});

const ClosedHoldStep = Schema.Struct({
  status: Schema.Literals(["settled", "released", "expired"]),
  transition: HoldMove,
});

const TerminalStep = Schema.Struct({
  phase: Schema.Literals(["Expired", "Canceled"]),
  transition: StandingMove,
});

/**
 * A standing is either the empty one or an open one, and an open one may or
 * may not already be scheduled to cancel. Those two bits are the whole state
 * `standingTransitionOf` reads, so a generated pair exercises both branches
 * without building a full aggregate.
 */
const StateShape = Schema.Struct({
  subscribed: Schema.Boolean,
  cancelAtPeriodEnd: Schema.Boolean,
});

type StateShape = typeof StateShape.Type;

const openStanding = subscribedAt("free");

const stateFor = ({ subscribed, cancelAtPeriodEnd }: StateShape): SubscriptionState =>
  subscribed ? { ...openStanding, cancelAtPeriodEnd } : initialSubscriptionState;

/**
 * The command tags the classifiers know, plus a tag neither knows. The union
 * with `Schema.String` in `CommandTag` covers arbitrary unknown tags as well.
 */
const KnownCommandTag = Schema.Literals([
  "Hold",
  "SettleHold",
  "ReleaseHold",
  "HoldElapsed",
  "StartTrial",
  "Subscribe",
  "EnterGrace",
  "RecordPaymentFailure",
  "RecordPayment",
  "Recover",
  "GraceElapsed",
  "Expire",
  "ClosePeriod",
  "PeriodEnded",
  "ScheduleCancellation",
  "Resume",
  "ChangeTier",
  "ScheduleTierChange",
  "WithdrawTierChange",
  "GrantCredits",
  "ConsumeCredits",
  "ExtendTrial",
  "PurchaseCredits",
  "TrackUsage",
  "Refund",
  "AttachProviderRef",
  "NotACommand",
]);

const CommandTag = Schema.Union([KnownCommandTag, Schema.String]);

/** One command tag and the two state bits a classifier may read. */
const ClassifiedCommand = Schema.Struct({
  tag: CommandTag,
  state: StateShape,
});

/**
 * The four hold tags and their moves. A tag outside this map is `none`, so
 * the classifier is total over every command, not only the hold commands.
 */
const HOLD_MOVE_OF_TAG: Readonly<Record<string, HoldTransition>> = {
  Hold: "hold",
  SettleHold: "settle",
  ReleaseHold: "release",
  HoldElapsed: "expire",
};

/**
 * The standing commands and their moves. A close is absent on purpose: it is
 * classified by the standing's cancellation flag, not by its tag alone.
 */
const STANDING_MOVE_OF_TAG: Readonly<Record<string, StandingTransition>> = {
  StartTrial: "trial",
  Subscribe: "activate",
  EnterGrace: "dunning",
  RecordPaymentFailure: "dunning",
  RecordPayment: "payment",
  Recover: "payment",
  GraceElapsed: "expire",
  Expire: "expire",
  ScheduleCancellation: "scheduleCancellation",
  Resume: "withdrawCancellation",
  ChangeTier: "changeTier",
  ScheduleTierChange: "changeTier",
  WithdrawTierChange: "changeTier",
};

const holdMoveOf = (tag: string): HoldTransition => {
  const move = HOLD_MOVE_OF_TAG[tag];

  return Object.hasOwn(HOLD_MOVE_OF_TAG, tag) && move !== undefined ? move : "none";
};

const standingMoveOf = (tag: string): StandingTransition => {
  if (tag === "ClosePeriod" || tag === "PeriodEnded") return "close";

  const move = STANDING_MOVE_OF_TAG[tag];

  return Object.hasOwn(STANDING_MOVE_OF_TAG, tag) && move !== undefined ? move : "other";
};

const phases: ReadonlyArray<StandingPhaseTag> = [...StandingPhaseTag.literals];

/** The phase pairs the total table can reach, computed from the table alone. */
const tableEdges = (): ReadonlySet<string> => {
  const edges = new Set<string>();

  for (const from of phases) {
    for (const transition of STANDING_TRANSITIONS) {
      edges.add(`${from}->${nextStandingPhase(from, transition)}`);
    }
  }

  return edges;
};

/** Every phase reachable from `Unsubscribed` by repeatedly following the table. */
const reachableFromUnsubscribed = (): ReadonlySet<StandingPhaseTag> => {
  const reached = new Set<StandingPhaseTag>(["Unsubscribed"]);
  const queue: Array<StandingPhaseTag> = ["Unsubscribed"];

  for (let index = 0; index < queue.length; index += 1) {
    const from = queue[index];

    if (from === undefined) continue;

    for (const transition of STANDING_TRANSITIONS) {
      const to = nextStandingPhase(from, transition);

      if (!reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
    }
  }

  return reached;
};

describe("the hold transition table", () => {
  it.effect("answers every status and move with a hold status", () =>
    assertProperty(
      Arbitrary.schema(HoldStep),
      ({ status, transition }) => {
        const to = nextHoldStatus(status, transition);
        const fromTable = HOLD_STATUS_TRANSITIONS[status][transition];

        // The helper must be a single lookup into the table, and the answer
        // must be one of the statuses the table knows how to write.
        return to === fromTable && HoldStatus.literals.includes(to);
      },
      { runs: 80, size: 20 },
    ),
  );

  it.effect("lets an open hold leave only for settle, release or expire", () =>
    assertProperty(
      Arbitrary.schema(HoldMove),
      (transition) => {
        const to = nextHoldStatus("open", transition);

        switch (transition) {
          case "hold":
          case "none":
            return to === "open";
          case "settle":
            return to === "settled";
          case "release":
            return to === "released";
          case "expire":
            return to === "expired";
        }
      },
      { runs: 40, size: 10 },
    ),
  );

  it.effect("keeps every closed hold absorbing under every move", () =>
    assertProperty(
      Arbitrary.schema(ClosedHoldStep),
      ({ status, transition }) => nextHoldStatus(status, transition) === status,
      { runs: 80, size: 20 },
    ),
  );

  it.effect("treats `none` as a self-edge for every status", () =>
    assertProperty(
      Arbitrary.schema(HoldStatus),
      (status) => nextHoldStatus(status, "none") === status,
      { runs: 40, size: 10 },
    ),
  );

  it("maps the four hold commands and nothing else", () => {
    for (const [tag, move] of Object.entries(HOLD_MOVE_OF_TAG)) {
      expect(holdTransitionOf({ _tag: tag })).toBe(move);
    }

    expect(holdTransitionOf({ _tag: "TrackUsage" })).toBe("none");
    expect(holdTransitionOf({ _tag: "ClosePeriod" })).toBe("none");
  });

  it.effect("classifies every generated command tag deterministically", () =>
    assertProperty(
      Arbitrary.schema(Schema.Struct({ tag: CommandTag })),
      ({ tag }) => {
        const transition = holdTransitionOf({ _tag: tag });
        const expected = holdMoveOf(tag);

        // The answer is always a column of the table, the same on a second
        // call, and `none` for every tag that is not a hold command.
        return (
          HOLD_TRANSITIONS.includes(transition) &&
          transition === expected &&
          transition === holdTransitionOf({ _tag: tag })
        );
      },
      { runs: 100, size: 20 },
    ),
  );
});

describe("the standing phase transition table", () => {
  it.effect("answers every phase and move with a phase tag", () =>
    assertProperty(
      Arbitrary.schema(StandingStep),
      ({ phase, transition }) => {
        const to = nextStandingPhase(phase, transition);

        return to === STANDING_PHASE_TRANSITIONS[phase][transition] && phases.includes(to);
      },
      { runs: 80, size: 20 },
    ),
  );

  it.effect("treats `other` as a self-edge in every phase", () =>
    assertProperty(
      Arbitrary.schema(StandingPhaseTag),
      (phase) => nextStandingPhase(phase, "other") === phase,
      { runs: 40, size: 10 },
    ),
  );

  it("agrees edge-for-edge with the table, including the annotated edge list", () => {
    const edges = tableEdges();
    const annotated = STANDING_PHASE_EDGES.map((edge) => `${edge.from}->${edge.to}`);

    // The annotated list is the table's view, not a second table: every pair
    // appears once, and no pair appears that the table cannot reach.
    expect(new Set(annotated).size).toBe(annotated.length);
    expect([...annotated].sort()).toEqual([...edges].sort());

    for (const from of phases) {
      for (const to of phases) {
        const allowed = edges.has(`${from}->${to}`);

        expect(isStandingPhaseEdge(from, to)).toBe(allowed);

        const edge = standingPhaseEdge(from, to);

        if (!allowed) {
          expect(edge).toBe(null);
          continue;
        }

        expect(edge).not.toBe(null);

        if (edge === null) continue;

        expect(edge.from).toBe(from);
        expect(edge.to).toBe(to);
        expect(edge.by.length).toBeGreaterThan(0);
      }
    }
  });

  it("reaches every phase from Unsubscribed through the table's edges", () => {
    expect([...reachableFromUnsubscribed()].sort()).toEqual([...phases].sort());
  });

  it("classifies a close by the standing's cancellation flag", () => {
    for (const tag of ["ClosePeriod", "PeriodEnded"] as const) {
      expect(standingTransitionOf({ _tag: tag }, initialSubscriptionState)).toBe("close");
      expect(standingTransitionOf({ _tag: tag }, openStanding)).toBe("close");
      expect(
        standingTransitionOf({ _tag: tag }, { ...openStanding, cancelAtPeriodEnd: true }),
      ).toBe("cancelAtBoundary");
    }
  });

  it("classifies the standing commands by tag", () => {
    for (const [tag, move] of Object.entries(STANDING_MOVE_OF_TAG)) {
      expect(standingTransitionOf({ _tag: tag }, openStanding)).toBe(move);
    }

    expect(standingTransitionOf({ _tag: "GrantCredits" }, openStanding)).toBe("other");
  });

  it.effect("classifies every generated command tag against every state shape", () =>
    assertProperty(
      Arbitrary.schema(ClassifiedCommand),
      ({ tag, state }) => {
        const command = { _tag: tag };
        const transition = standingTransitionOf(command, stateFor(state));

        const expected =
          state.subscribed && state.cancelAtPeriodEnd && standingMoveOf(tag) === "close"
            ? "cancelAtBoundary"
            : standingMoveOf(tag);

        return (
          STANDING_TRANSITIONS.includes(transition) &&
          transition === expected &&
          transition === standingTransitionOf(command, stateFor(state))
        );
      },
      { runs: 100, size: 20 },
    ),
  );

  it("keeps terminal phases put except where the table reopens them", () => {
    const stays: ReadonlyArray<StandingTransition> = [
      "dunning",
      "payment",
      "expire",
      "close",
      "cancelAtBoundary",
      "scheduleCancellation",
      "withdrawCancellation",
      "changeTier",
      "other",
    ];

    for (const phase of ["Expired", "Canceled"] as const) {
      const leaving = STANDING_TRANSITIONS.filter(
        (transition) => nextStandingPhase(phase, transition) !== phase,
      );

      // A terminal phase only leaves for the two moves that open a standing
      // again; every other move is a self-edge derived from the table.
      expect(leaving).toEqual(["trial", "activate"]);

      for (const transition of stays) {
        expect(nextStandingPhase(phase, transition)).toBe(phase);
      }
    }
  });

  it.effect("keeps a terminal phase for every move but trial and activate", () =>
    assertProperty(
      Arbitrary.schema(TerminalStep),
      ({ phase, transition }) => {
        const reopened = transition === "trial" || transition === "activate";

        return (nextStandingPhase(phase, transition) !== phase) === reopened;
      },
      { runs: 60, size: 20 },
    ),
  );
});
