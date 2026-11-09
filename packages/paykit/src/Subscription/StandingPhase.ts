import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  creditsOf,
  type SubscriptionState,
  type SubscriptionStatus,
} from "./Subscription.state.ts";

/**
 * The phases a standing can be in. `Expired` and `Canceled` are terminal for
 * the period machine, but a later activation can still open a new standing.
 */
export const StandingPhaseTag = Schema.Literals([
  "Unsubscribed",
  "Trialing",
  "Active",
  "Grace",
  "Expired",
  "Canceled",
]);

export type StandingPhaseTag = typeof StandingPhaseTag.Type;

/**
 * One standing's phase at an instant.
 *
 * The tag is the stored status, not a replacement for it. `deadline` is the
 * boundary that will move the phase when its scheduled command runs, and
 * `overdue` says that boundary has passed and the log has not caught up. That
 * is the difference between "the trial ended" and "the close was recorded":
 * a standing can be `Trialing` with `overdue: true` until `PeriodEnded` lands.
 */
export const StandingPhase = Schema.Union([
  Schema.TaggedStruct("Unsubscribed", {}),
  Schema.TaggedStruct("Trialing", {
    /** The close that converts the trial into the next period. */
    deadline: Schema.DateTimeUtc,
    overdue: Schema.Boolean,
  }),
  Schema.TaggedStruct("Active", {
    /** The end of the open period. */
    deadline: Schema.DateTimeUtc,
    overdue: Schema.Boolean,
  }),
  Schema.TaggedStruct("Grace", {
    /** The dunning deadline, or `null` when the standing states none. */
    deadline: Schema.NullOr(Schema.DateTimeUtc),
    overdue: Schema.Boolean,
  }),
  Schema.TaggedStruct("Expired", {}),
  Schema.TaggedStruct("Canceled", {}),
]);

export type StandingPhase = typeof StandingPhase.Type;

/** The auto top-up window: closed, open, or past its deadline but not cleared. */
export const TopUpCooldownCondition = Schema.Literals(["none", "open", "lapsed"]);

export type TopUpCooldownCondition = typeof TopUpCooldownCondition.Type;

/** The last tier change's money: absent, owed, billed, or a credit. */
export const ProrationCondition = Schema.Literals(["none", "owed", "billed", "credit"]);

export type ProrationCondition = typeof ProrationCondition.Type;

/**
 * The state that sits beside the phase and decides which edges are legal: a
 * scheduled cancellation or tier, an open or lapsed reservation, the money a
 * tier change moved, and credits a pack bought before any plan existed.
 *
 * These are separate from the phase because they are orthogonal to it. An
 * active standing can have any of them at once, and none of them is a status.
 */
export const StandingConditions = Schema.Struct({
  /** Whether this account has ever started a trial. */
  trialUsed: Schema.Boolean,
  /** A cancellation is recorded for the period boundary. */
  cancelAtPeriodEnd: Schema.Boolean,
  /** The tier the boundary will move to, or `null` when nothing is scheduled. */
  pendingTier: Schema.NullOr(Schema.String),
  /** The auto top-up cooldown, including the deadline that has passed unseen. */
  topUpCooldown: TopUpCooldownCondition,
  /** Holds the aggregate still counts as open. */
  openHolds: Schema.Int,
  /** The subset of `openHolds` whose deadline has passed. */
  lapsedHolds: Schema.Int,
  /** The money the last tier change moved, and whether it was billed. */
  proration: ProrationCondition,
  /** Credits a one-off pack bought before a standing existed. */
  unplannedCredits: Schema.Int,
});

export type StandingConditions = typeof StandingConditions.Type;

const reached = (at: DateTime.Utc, deadline: DateTime.Utc): boolean =>
  DateTime.toEpochMillis(at) >= DateTime.toEpochMillis(deadline);

/**
 * The phase a standing is in at `at`.
 *
 * `status` alone is not the phase. A trial whose deadline has passed is still
 * `Trialing` until `PeriodEnded` records the close; an active standing past
 * its period end is still `Active`; a grace window whose deadline passed is
 * still `Grace`. `overdue` is the clock, and the tag is the log. Reading only
 * the status hides the window between the two.
 *
 * Pure: the clock is a parameter, so a console, a test and a replay can ask
 * the same question of the same state.
 *
 * ### Reading a phase
 * **Example:** A trial whose deadline has passed, waiting for the close
 * ```typescript
 * const phase = standingPhaseOf(state, at);
 * // { _tag: "Trialing", deadline: 2030-01-15T00:00:00Z, overdue: true }
 * ```
 *
 * @primitive
 */
export const standingPhaseOf = (state: SubscriptionState, at: DateTime.Utc): StandingPhase => {
  if (state._tag === "Unsubscribed") return { _tag: "Unsubscribed" };

  // The close, not `trialEndsAt`, is what actually moves a trial: the
  // rollover is scheduled from `period.end` and `ExtendTrial` keeps the two
  // together. A view carries the same period end, so both paths agree.
  return phaseFrom(state.status, state.period.end, state.graceUntil, at);
};

const phaseFrom = (
  status: SubscriptionStatus,
  periodEnd: DateTime.Utc,
  graceUntil: DateTime.Utc | undefined,
  at: DateTime.Utc,
): StandingPhase => {
  switch (status) {
    case "trialing":
      return { _tag: "Trialing", deadline: periodEnd, overdue: reached(at, periodEnd) };
    case "active":
      return { _tag: "Active", deadline: periodEnd, overdue: reached(at, periodEnd) };
    case "grace":
      return {
        _tag: "Grace",
        deadline: graceUntil ?? null,
        overdue: graceUntil === undefined ? false : reached(at, graceUntil),
      };
    case "expired":
      return { _tag: "Expired" };
    case "canceled":
      return { _tag: "Canceled" };
  }
};

/** The fields a read model must carry for its phase to be derived. */
export interface StandingPhaseView {
  readonly status: SubscriptionStatus;
  readonly periodEnd: DateTime.Utc;
  readonly graceUntil?: DateTime.Utc | undefined;
}

/**
 * The phase of a standing a read model carries. The view has the status and
 * the boundary, so a console can say "the period ended and no close has
 * landed" without holding the aggregate state.
 *
 * ### Reading a phase from a billing row
 * **Example:** The account page's status, with its overdue flag
 * ```typescript
 * standingPhaseOfView(billing, readAt);
 * // { _tag: "Active", deadline: 2030-02-01T00:00:00Z, overdue: true }
 * ```
 *
 * @primitive
 */
export const standingPhaseOfView = (view: StandingPhaseView, at: DateTime.Utc): StandingPhase =>
  phaseFrom(view.status, view.periodEnd, view.graceUntil, at);

/**
 * The phase tag a status alone names. A read model that has no clock can still
 * say which phase it is in; `overdue` needs `standingPhaseOfView`.
 *
 * ### Classifying a status
 * **Example:** The action list's phase
 * ```typescript
 * standingPhaseTagOfStatus("grace"); // "Grace"
 * ```
 *
 * @primitive
 */
export const standingPhaseTagOfStatus = (
  status: SubscriptionStatus,
): Exclude<StandingPhaseTag, "Unsubscribed"> => {
  switch (status) {
    case "trialing":
      return "Trialing";
    case "active":
      return "Active";
    case "grace":
      return "Grace";
    case "expired":
      return "Expired";
    case "canceled":
      return "Canceled";
  }
};

/**
 * The orthogonal state a standing carries beside its phase.
 *
 * The phase says where the lifecycle is; these say what the next command will
 * find when it gets there. A pending tier on an expired standing, a cooldown
 * whose deadline passed, a hold past its expiry and a proration credit with no
 * consumer are all visible here instead of being inferred from absent fields.
 *
 * ### Reading what the next command will see
 * **Example:** A scheduled change and a lapsed cooldown on one standing
 * ```typescript
 * const conditions = standingConditionsOf(state, at);
 * // { pendingTier: "pro", topUpCooldown: "lapsed", lapsedHolds: 1, ... }
 * ```
 *
 * @primitive
 */
export const standingConditionsOf = (
  state: SubscriptionState,
  at: DateTime.Utc,
): StandingConditions => {
  if (state._tag === "Unsubscribed") {
    return {
      trialUsed: false,
      cancelAtPeriodEnd: false,
      pendingTier: null,
      topUpCooldown: "none",
      openHolds: 0,
      lapsedHolds: 0,
      proration: "none",
      unplannedCredits: creditsOf(state),
    };
  }

  const holds = Object.values(state.holds).filter((hold) => hold.status === "open");
  const lapsedHolds = holds.filter((hold) => reached(at, hold.expiresAt)).length;

  const cooldown =
    state.topUpCooldownUntil === undefined
      ? "none"
      : reached(at, state.topUpCooldownUntil)
        ? "lapsed"
        : "open";

  const proration =
    state.proration === undefined
      ? "none"
      : state.proration.due <= 0
        ? "credit"
        : state.prorationInvoice === undefined
          ? "owed"
          : "billed";

  return {
    trialUsed: state.trialUsed,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    pendingTier: state.pendingTier?.tier ?? null,
    topUpCooldown: cooldown,
    openHolds: holds.length,
    lapsedHolds,
    proration,
    unplannedCredits: 0,
  };
};

/** One semantic move a command can make against a standing. */
export const STANDING_TRANSITIONS = [
  "trial",
  "activate",
  "dunning",
  "payment",
  "expire",
  "close",
  "cancelAtBoundary",
  "scheduleCancellation",
  "withdrawCancellation",
  "changeTier",
  "other",
] as const;

export type StandingTransition = (typeof STANDING_TRANSITIONS)[number];

/**
 * Every phase under every move. A total table, not a sparse edge list: a move
 * that cannot happen is a self-edge, so a reader can ask `[phase][move]`
 * instead of replaying a chain of guards. The shape is Alchemy's
 * `SQLITE_TRANSITIONS` table in `@alchemy.run/sql/SqlFile`: every state has
 * every token and the runner is a single index.
 *
 * The surprising cells are the honest ones. `Active + trial -> Trialing` is
 * reachable because `StartTrial` guards on `trialUsed`, not on the standing
 * already being open; `Expired + activate -> Active` is how a payment
 * reactivates a terminal account. Anything a later guard refuses becomes a
 * self-edge here, which is the same edit as changing the guard.
 *
 * @primitive
 */
export const STANDING_PHASE_TRANSITIONS: Record<
  StandingPhaseTag,
  Record<StandingTransition, StandingPhaseTag>
> = {
  Unsubscribed: {
    trial: "Trialing",
    activate: "Active",
    dunning: "Unsubscribed",
    payment: "Unsubscribed",
    expire: "Unsubscribed",
    close: "Unsubscribed",
    cancelAtBoundary: "Unsubscribed",
    scheduleCancellation: "Unsubscribed",
    withdrawCancellation: "Unsubscribed",
    changeTier: "Unsubscribed",
    other: "Unsubscribed",
  },
  Trialing: {
    trial: "Trialing",
    activate: "Active",
    dunning: "Grace",
    payment: "Trialing",
    expire: "Trialing",
    close: "Active",
    cancelAtBoundary: "Canceled",
    scheduleCancellation: "Trialing",
    withdrawCancellation: "Trialing",
    changeTier: "Trialing",
    other: "Trialing",
  },
  Active: {
    trial: "Trialing",
    activate: "Active",
    dunning: "Grace",
    payment: "Active",
    expire: "Active",
    close: "Active",
    cancelAtBoundary: "Canceled",
    scheduleCancellation: "Active",
    withdrawCancellation: "Active",
    changeTier: "Active",
    other: "Active",
  },
  Grace: {
    trial: "Trialing",
    activate: "Active",
    dunning: "Grace",
    payment: "Active",
    expire: "Expired",
    close: "Grace",
    cancelAtBoundary: "Canceled",
    scheduleCancellation: "Grace",
    withdrawCancellation: "Grace",
    changeTier: "Grace",
    other: "Grace",
  },
  Expired: {
    trial: "Trialing",
    activate: "Active",
    dunning: "Expired",
    payment: "Expired",
    expire: "Expired",
    close: "Expired",
    cancelAtBoundary: "Expired",
    scheduleCancellation: "Expired",
    withdrawCancellation: "Expired",
    changeTier: "Expired",
    other: "Expired",
  },
  Canceled: {
    trial: "Trialing",
    activate: "Active",
    dunning: "Canceled",
    payment: "Canceled",
    expire: "Canceled",
    close: "Canceled",
    cancelAtBoundary: "Canceled",
    scheduleCancellation: "Canceled",
    withdrawCancellation: "Canceled",
    changeTier: "Canceled",
    other: "Canceled",
  },
};

/**
 * The phase tag one move leaves behind. Total in both arguments: an impossible
 * move answers the same tag, so a caller never has to handle `undefined` just
 * because the standing refused the command.
 *
 * ### Asking the table
 * **Example:** What an expiry does to grace
 * ```typescript
 * nextStandingPhase("Grace", "expire"); // "Expired"
 * nextStandingPhase("Active", "expire"); // "Active"
 * ```
 *
 * @primitive
 */
export const nextStandingPhase = (
  phase: StandingPhaseTag,
  transition: StandingTransition,
): StandingPhaseTag => STANDING_PHASE_TRANSITIONS[phase][transition];

const COMMAND_TRANSITIONS = {
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
} satisfies Readonly<Record<string, StandingTransition>>;

/**
 * The move a command names, as the table's second key.
 *
 * A close is the one command whose move depends on the standing: with a
 * cancellation scheduled it is `cancelAtBoundary`, otherwise `close`. Every
 * other command is classified by its tag alone; a command that only touches
 * counters, credits or refs is `other`, which is a self-edge in every phase.
 *
 * A command that records nothing — an early `PeriodEnded`, a repeat `Expire`
 * — is not a move. The table classifies what a decision did, so a caller
 * holding an empty decision stays on the same phase without consulting it.
 *
 * ### Classifying a close
 * **Example:** A period ending on a standing already scheduled to cancel
 * ```typescript
 * standingTransitionOf({ _tag: "PeriodEnded" }, { ...state, cancelAtPeriodEnd: true });
 * // "cancelAtBoundary"
 * ```
 *
 * @primitive
 */
export const standingTransitionOf = (
  command: { readonly _tag: string },
  state: SubscriptionState,
): StandingTransition => {
  if (command._tag === "ClosePeriod" || command._tag === "PeriodEnded") {
    return state._tag === "Subscribed" && state.cancelAtPeriodEnd ? "cancelAtBoundary" : "close";
  }

  // SAFETY: `Object.hasOwn` checked the key, so this is a known command tag.
  return Object.hasOwn(COMMAND_TRANSITIONS, command._tag)
    ? COMMAND_TRANSITIONS[command._tag as keyof typeof COMMAND_TRANSITIONS]
    : "other";
};

/** One reachable phase edge, and the commands and events that take it. */
export interface StandingPhaseEdge {
  readonly from: StandingPhaseTag;
  readonly to: StandingPhaseTag;
  /** A command or event that can take this edge. */
  readonly by: ReadonlyArray<string>;
  /** Why the edge is reachable, when the tag alone does not say it. */
  readonly note?: string;
}

/**
 * The annotated view of {@link STANDING_PHASE_TRANSITIONS}: one row per pair of
 * phases the table can reach (including each phase's self-edge), with the
 * commands that take it and the notes a reader needs. The table is the source of truth; this list is how a
 * human reads it, and `test/standing/Phase.test.ts` holds the two together.
 *
 * @primitive
 */
export const STANDING_PHASE_EDGES: ReadonlyArray<StandingPhaseEdge> = [
  {
    from: "Unsubscribed",
    to: "Unsubscribed",
    by: ["PurchaseCredits", "TrackUsage", "Refund", "AttachProviderRef"],
  },
  {
    from: "Unsubscribed",
    to: "Trialing",
    by: ["StartTrial"],
  },
  {
    from: "Unsubscribed",
    to: "Active",
    by: ["Subscribe"],
  },
  {
    from: "Trialing",
    to: "Trialing",
    by: ["ExtendTrial", "UsageRecorded", "UsageReserved", "ScheduleCancellation"],
  },
  {
    from: "Trialing",
    to: "Active",
    by: ["PeriodClosed"],
  },
  {
    from: "Trialing",
    to: "Grace",
    by: ["EnterGrace", "PaymentFailed"],
  },
  {
    from: "Trialing",
    to: "Canceled",
    by: ["PeriodClosed"],
    note: "A close with `cancelAtPeriodEnd` sets the terminal status.",
  },
  {
    from: "Active",
    to: "Active",
    by: ["PlanChanged", "UsageRecorded", "UsageReserved", "PeriodClosed"],
    note: "`Subscribe` refuses an open standing; `StartTrial` is the one deliberate replacement.",
  },
  {
    from: "Active",
    to: "Trialing",
    by: ["StartTrial"],
    note: "`StartTrial` is guarded by `trialUsed`, not by the standing already being open.",
  },
  {
    from: "Active",
    to: "Grace",
    by: ["EnterGrace", "PaymentFailed"],
  },
  {
    from: "Active",
    to: "Canceled",
    by: ["PeriodClosed"],
    note: "A close with `cancelAtPeriodEnd` sets the terminal status.",
  },
  {
    from: "Grace",
    to: "Grace",
    by: ["PaymentFailed", "UsageRecorded", "ScheduleCancellation", "PeriodClosed"],
  },
  {
    from: "Grace",
    to: "Active",
    by: ["RecordPayment", "Recovered"],
  },
  {
    from: "Grace",
    to: "Trialing",
    by: ["StartTrial"],
    note: "A trial can replace a grace standing when `trialUsed` is false.",
  },
  {
    from: "Grace",
    to: "Canceled",
    by: ["PeriodClosed"],
    note: "A close with `cancelAtPeriodEnd` sets the terminal status.",
  },
  {
    from: "Grace",
    to: "Expired",
    by: ["GraceElapsed", "Expire"],
  },
  {
    from: "Expired",
    to: "Expired",
    by: ["GrantCredits", "ChangeTier", "ConsumeCredits", "Resume"],
    note: "Terminality is a per-command guard, not a global invariant.",
  },
  {
    from: "Expired",
    to: "Trialing",
    by: ["StartTrial"],
  },
  {
    from: "Expired",
    to: "Active",
    by: ["Subscribe"],
    note: "`payment_succeeded` uses this edge to reactivate an expired account.",
  },
  {
    from: "Canceled",
    to: "Canceled",
    by: ["GrantCredits", "ChangeTier", "Resume"],
    note: "`Resume` clears a cancellation flag that survived the terminal close.",
  },
  {
    from: "Canceled",
    to: "Trialing",
    by: ["StartTrial"],
  },
  {
    from: "Canceled",
    to: "Active",
    by: ["Subscribe"],
  },
];

const phaseEdgeKeys = new Set(
  Object.entries(STANDING_PHASE_TRANSITIONS).flatMap(([from, row]) =>
    Object.values(row).map((to) => `${from}->${to}`),
  ),
);

/** The edge that takes `from` to `to`, or `null` when no command may. */
export const standingPhaseEdge = (
  from: StandingPhaseTag,
  to: StandingPhaseTag,
): StandingPhaseEdge | null =>
  STANDING_PHASE_EDGES.find((edge) => edge.from === from && edge.to === to) ?? null;

/** Whether `from` may move to `to` in one command, read from the total table. */
export const isStandingPhaseEdge = (from: StandingPhaseTag, to: StandingPhaseTag): boolean =>
  phaseEdgeKeys.has(`${from}->${to}`);
