// A Quint model of the plan set: several groups, at most one plan per group, an
// add-on that stacks beside them, a multi-phase schedule, and the cancellation
// that resolves a group to its default plan or to nothing.
//
// This is the seventh protocol, and the one `plans.qnt` names as the next slice:
// `plans.qnt` keeps one plan because a second plan is a different invariant, not
// a second table row. The state here is the plan set, not the standing; the
// phase machine stays in `standing.qnt` and the sources a plan grants stay in
// `balances.qnt`.
//
// Source correspondence:
//   attach          ↔ Subscribe.command.ts / ChangeTier.command.ts
//                     (the classification is `plans.qnt`'s; this is the slot)
//   addAddOn        ↔ AddAddOn.binding.ts (and the add-on branch of Attach)
//   schedulePlan    ↔ ScheduleTierChange.command.ts
//   withdrawPhase   ↔ WithdrawTierChange.command.ts
//   applyPhase      ↔ ApplyPlanPhase.command.ts (scheduled by PlanPhaseSchedule)
//   cancelGroup     ↔ CancelGroup.command.ts (at the boundary)
//   cancelNow       ↔ CancelImmediately.command.ts
//   uncancelGroup   ↔ UncancelGroup.command.ts
//   close           ↔ ClosePeriod.command.ts / PeriodEnded.command.ts
//   tick            ↔ the platform clock
//
// Scope, the decisions this model grounds and what it deliberately leaves out
// are in README.md beside this file (ADR 0039).
module schedules {

  // ── types ──────────────────────────────────────────────────────────────────

  type GroupId = A | B

  // Two choices per group and one add-on. The catalogue is a constant because
  // the invariant is the shape of the set, not the number of plans a deployment
  // declares (ADR 0034 §2).
  type PlanId = A1 | A2 | B1 | B2 | AddOn

  // One phase: the plan a group moves to, and the instant it starts.
  type Phase = { plan: PlanId, at: int }

  // A schedule is ordered and holds at most two phases. The cardinality is not
  // the invariant, the order and the scope are.
  type Schedule = NoPhases | OnePhase(Phase) | TwoPhases((Phase, Phase))

  type State = {
    now: int,
    periodEnd: int,
    // A terminal account has no plans, no add-on and no future (ADR 0020).
    open: bool,
    // The plans running in each group. A set, not a slot, so that "at most one
    // per group" is a rule the model can break and an invariant can catch.
    plansA: Set[PlanId],
    plansB: Set[PlanId],
    // An add-on stacks beside whatever runs; it fills no group's slot.
    addOn: bool,
    // A cancellation waiting for the group's boundary, and the marker that says
    // the boundary resolved one (so a fallback can be checked afterwards).
    cancelPendingA: bool,
    cancelPendingB: bool,
    endedA: bool,
    endedB: bool,
    schedule: Schedule,
    // History, so a witness can name the path that was taken and an invariant
    // can compare what a phase did to the group it did not name.
    attaches: int,
    addOns: int,
    cancels: int,
    cancelsNow: int,
    uncancels: int,
    withdrawals: int,
    closes: int,
    applied: int,
    phaseKeptTheOtherGroup: bool,
    lastPhase: PlanId,
  }

  // ── the catalogue ──────────────────────────────────────────────────────────

  pure val GROUPS: Set[GroupId] = Set(A, B)
  pure val PLANS: Set[PlanId] = Set(A1, A2, B1, B2, AddOn)
  pure val NO_PLANS: Set[PlanId] = Set()

  pure val PERIOD_LENGTH: int = 5
  pure val MAX_PHASES: int = 2

  // Group A states a default plan, so a cancellation there falls back to it.
  // Group B states none, so a cancellation there leaves the group empty and the
  // account keeps its add-ons (ADR 0039 §5).
  pure def defaultOf(group: GroupId): Set[PlanId] =
    if (group == A) Set(A1) else NO_PLANS

  pure def isDefaultPlan(plan: PlanId): bool = plan == A1

  pure def isAddOn(plan: PlanId): bool = plan == AddOn

  // Every plan but the add-on belongs to a group. `groupOf` is only meaningful
  // once `isGroupPlan` holds; the add-on answers B so that a mistake which files
  // it in a group is caught by `addOnsStack` rather than hidden here.
  pure def isGroupPlan(plan: PlanId): bool = plan != AddOn

  pure def groupOf(plan: PlanId): GroupId =
    if (plan == A1 or plan == A2) A else B

  pure def priceOf(plan: PlanId): int =
    if (plan == A1) 0 else if (plan == A2) 20 else if (plan == B1) 10 else if (plan == B2) 30 else 5

  // ── the schedule ───────────────────────────────────────────────────────────

  pure def phaseCount(schedule: Schedule): int =
    match schedule {
      | NoPhases => 0
      | OnePhase(_) => 1
      | TwoPhases(_) => 2
    }

  pure def firstPhase(schedule: Schedule): Phase =
    match schedule {
      | NoPhases => { plan: A1, at: 0 }
      | OnePhase(phase) => phase
      | TwoPhases(pair) => pair._1
    }

  pure def secondPhase(schedule: Schedule): Phase =
    match schedule {
      | NoPhases => { plan: A1, at: 0 }
      | OnePhase(phase) => phase
      | TwoPhases(pair) => pair._2
    }

  pure def firstAt(schedule: Schedule): int = firstPhase(schedule).at

  // A phase is due exactly at its instant. The clock stops there, so a phase is
  // never applied late and never skipped (ADR 0039 §3).
  pure def phaseDue(s: State): bool =
    phaseCount(s.schedule) > 0 and firstAt(s.schedule) == s.now

  pure def dropFirst(schedule: Schedule): Schedule =
    match schedule {
      | NoPhases => NoPhases
      | OnePhase(_) => NoPhases
      | TwoPhases(pair) => OnePhase(pair._2)
    }

  // Insertion keeps the list ordered by instant. Two phases at the same instant
  // are refused by the guard, not merged here.
  pure def addPhase(schedule: Schedule, phase: Phase): Schedule =
    match schedule {
      | NoPhases => OnePhase(phase)
      | OnePhase(first) =>
          if (phase.at < first.at) TwoPhases((phase, first)) else TwoPhases((first, phase))
      | TwoPhases(pair) => TwoPhases(pair)
    }

  pure def hasPhaseAt(schedule: Schedule, at: int): bool =
    match schedule {
      | NoPhases => false
      | OnePhase(first) => first.at == at
      | TwoPhases(pair) => pair._1.at == at or pair._2.at == at
    }

  pure def hasPhaseFor(schedule: Schedule, plan: PlanId): bool =
    match schedule {
      | NoPhases => false
      | OnePhase(first) => first.plan == plan
      | TwoPhases(pair) => pair._1.plan == plan or pair._2.plan == plan
    }

  // A move or a cancellation wins the boundary, so everything the group still
  // had waiting is dropped (ADR 0012 §3, ADR 0039 §5).
  pure def dropPhasesOf(schedule: Schedule, group: GroupId): Schedule =
    match schedule {
      | NoPhases => NoPhases
      | OnePhase(first) =>
          if (groupOf(first.plan) == group) NoPhases else OnePhase(first)
      | TwoPhases(pair) =>
          if (groupOf(pair._1.plan) != group and groupOf(pair._2.plan) != group) TwoPhases(pair)
          else if (groupOf(pair._1.plan) != group) OnePhase(pair._1)
          else if (groupOf(pair._2.plan) != group) OnePhase(pair._2)
          else NoPhases
    }

  pure def removePhase(schedule: Schedule, plan: PlanId): Schedule =
    match schedule {
      | NoPhases => NoPhases
      | OnePhase(first) => if (first.plan == plan) NoPhases else OnePhase(first)
      | TwoPhases(pair) =>
          if (pair._1.plan == plan) OnePhase(pair._2)
          else if (pair._2.plan == plan) OnePhase(pair._1)
          else TwoPhases(pair)
    }

  pure def phasesOrdered(schedule: Schedule): bool =
    match schedule {
      | NoPhases => true
      | OnePhase(_) => true
      | TwoPhases(pair) => pair._1.at < pair._2.at
    }

  pure def phasesAtOrAfter(schedule: Schedule, instant: int): bool =
    match schedule {
      | NoPhases => true
      | OnePhase(first) => first.at >= instant
      | TwoPhases(pair) => pair._1.at >= instant and pair._2.at >= instant
    }

  pure def phasesNameGroupPlans(schedule: Schedule): bool =
    match schedule {
      | NoPhases => true
      | OnePhase(first) => isGroupPlan(first.plan)
      | TwoPhases(pair) => isGroupPlan(pair._1.plan) and isGroupPlan(pair._2.plan)
    }

  // ── the plan set ───────────────────────────────────────────────────────────

  pure def plansOf(s: State, group: GroupId): Set[PlanId] =
    if (group == A) s.plansA else s.plansB

  pure def withPlansOf(s: State, group: GroupId, plans: Set[PlanId]): State =
    if (group == A) { ...s, plansA: plans } else { ...s, plansB: plans }

  pure def cancelPendingOf(s: State, group: GroupId): bool =
    if (group == A) s.cancelPendingA else s.cancelPendingB

  pure def withCancelPendingOf(s: State, group: GroupId, pending: bool): State =
    if (group == A) { ...s, cancelPendingA: pending } else { ...s, cancelPendingB: pending }

  pure def endedOf(s: State, group: GroupId): bool =
    if (group == A) s.endedA else s.endedB

  pure def withEndedOf(s: State, group: GroupId, ended: bool): State =
    if (group == A) { ...s, endedA: ended } else { ...s, endedB: ended }

  pure def anyPlan(s: State): bool = s.plansA.size() + s.plansB.size() > 0

  // An attach is a new plan or a replacement in the plan's group. The plan
  // already running is a no-op, so the action is disabled (plans.qnt's `Noop`).
  pure def canAttach(s: State, plan: PlanId): bool =
    s.open and isGroupPlan(plan) and not(plansOf(s, groupOf(plan)).contains(plan))

  pure def applyAttach(s: State, plan: PlanId): State = {
    val group = groupOf(plan)
    val moved = withPlansOf(s, group, Set(plan))
    // A move clears the cancellation and the resolved-cancel marker it
    // supersedes, and drops every phase the group still had waiting.
    val cleared = withEndedOf(withCancelPendingOf(moved, group, false), group, false)
    {
      ...cleared,
      schedule: dropPhasesOf(s.schedule, group),
      attaches: s.attaches + 1,
    }
  }

  pure def canAddAddOn(s: State): bool = s.open and not(s.addOn)

  pure def applyAddAddOn(s: State): State = {
    ...s,
    addOn: true,
    addOns: s.addOns + 1,
  }

  pure def canSchedulePlan(s: State, plan: PlanId, at: int): bool = and {
    s.open,
    isGroupPlan(plan),
    at > s.now,
    phaseCount(s.schedule) < MAX_PHASES,
    not(hasPhaseAt(s.schedule, at)),
  }

  pure def applySchedulePlan(s: State, plan: PlanId, at: int): State = {
    ...s,
    schedule: addPhase(s.schedule, { plan: plan, at: at }),
  }

  pure def canWithdrawPhase(s: State, plan: PlanId): bool =
    s.open and hasPhaseFor(s.schedule, plan)

  pure def applyWithdrawPhase(s: State, plan: PlanId): State = {
    ...s,
    schedule: removePhase(s.schedule, plan),
    withdrawals: s.withdrawals + 1,
  }

  pure def canApplyPhase(s: State): bool = s.open and phaseDue(s)

  // A phase moves exactly the group its plan belongs to. It clears that group's
  // pending cancellation and marker, because an explicit move supersedes them,
  // and it records whether the other group was left alone.
  pure def applyPhaseTo(s: State): State = {
    val due = firstPhase(s.schedule)
    val group = groupOf(due.plan)
    // The record is built first, so the history flag reads what was written
    // rather than what was intended.
    val moved = {
      ...s,
      plansA: if (group == A) Set(due.plan) else s.plansA,
      plansB: if (group == B) Set(due.plan) else s.plansB,
    }
    {
      ...moved,
      cancelPendingA: if (group == A) false else s.cancelPendingA,
      cancelPendingB: if (group == B) false else s.cancelPendingB,
      endedA: if (group == A) false else s.endedA,
      endedB: if (group == B) false else s.endedB,
      schedule: dropFirst(s.schedule),
      applied: s.applied + 1,
      lastPhase: due.plan,
      phaseKeptTheOtherGroup: if (group == A) moved.plansB == s.plansB else moved.plansA == s.plansA,
    }
  }

  // A plan can be cancelled unless it is its group's default: cancelling the
  // floor would replace it with itself, so it is refused (ADR 0039 §5).
  pure def cancellable(s: State, group: GroupId): bool =
    s.open
      and plansOf(s, group).size() == 1
      and not(plansOf(s, group).exists(plan => isDefaultPlan(plan)))

  pure def canCancelGroup(s: State, group: GroupId): bool =
    cancellable(s, group) and not(cancelPendingOf(s, group))

  pure def applyCancelGroup(s: State, group: GroupId): State = {
    ...withCancelPendingOf(s, group, true),
    schedule: dropPhasesOf(s.schedule, group),
    cancels: s.cancels + 1,
  }

  pure def canUncancelGroup(s: State, group: GroupId): bool =
    s.open and cancelPendingOf(s, group)

  pure def applyUncancelGroup(s: State, group: GroupId): State = {
    ...withCancelPendingOf(s, group, false),
    uncancels: s.uncancels + 1,
  }

  // The immediate branch of an update operation: the same resolution the
  // boundary performs, performed now.
  pure def canCancelNow(s: State, group: GroupId): bool =
    cancellable(s, group)

  pure def applyCancelNow(s: State, group: GroupId): State = {
    val resolved = withPlansOf(s, group, defaultOf(group))
    val ended = withEndedOf(withCancelPendingOf(resolved, group, false), group, true)
    {
      ...ended,
      schedule: dropPhasesOf(s.schedule, group),
      cancelsNow: s.cancelsNow + 1,
    }
  }

  pure def canClose(s: State): bool = s.open and s.now >= s.periodEnd

  // The boundary resolves every pending cancellation, rolls the period, and
  // ends an account that no longer holds a plan in any group. An add-on does not
  // keep an account open: there is nothing left to bill.
  pure def applyClose(s: State): State = {
    val plansA = if (s.cancelPendingA) defaultOf(A) else s.plansA
    val plansB = if (s.cancelPendingB) defaultOf(B) else s.plansB
    val stillOpen = plansA.size() + plansB.size() > 0
    {
      ...s,
      plansA: plansA,
      plansB: plansB,
      cancelPendingA: false,
      cancelPendingB: false,
      endedA: s.endedA or s.cancelPendingA,
      endedB: s.endedB or s.cancelPendingB,
      periodEnd: if (stillOpen) s.periodEnd + PERIOD_LENGTH else s.periodEnd,
      open: stillOpen,
      addOn: if (stillOpen) s.addOn else false,
      schedule: if (stillOpen) s.schedule else NoPhases,
      closes: s.closes + 1,
    }
  }

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // ADR 0039 §1: a group holds at most one plan, so a second plan in the same
  // group is a move, never a second subscription.
  val oneActivePerGroup: bool =
    state.plansA.size() <= 1 and state.plansB.size() <= 1

  // ADR 0039 §2: a group slot holds a plan of that group; the add-on fills no
  // slot and belongs to no group. Both halves of "an add-on stacks beside".
  val addOnsStack: bool = and {
    not(state.plansA.contains(AddOn)),
    not(state.plansB.contains(AddOn)),
    state.plansA.forall(plan => isGroupPlan(plan) and groupOf(plan) == A),
    state.plansB.forall(plan => isGroupPlan(plan) and groupOf(plan) == B),
  }

  // ADR 0039 §2: once attached, an add-on survives every move, phase and
  // cancellation. Only the terminal close takes it away.
  val addOnsSurviveGroupChange: bool =
    not(state.addOns > 0) or state.addOn or not(state.open)

  // ADR 0039 §3: a phase is future-only. A phase due now is applied before the
  // clock may move, so no pending phase is ever behind the clock.
  val phasesAreFuture: bool = phasesAtOrAfter(state.schedule, state.now)

  // ADR 0039 §3: phases are strictly ordered, which is also what makes "at most
  // one phase per instant" true.
  val phasesAreOrdered: bool = phasesOrdered(state.schedule)

  // ADR 0039 §4: a phase names a group's plan, never the add-on, and applying it
  // changes that group alone.
  val phaseNeverSkipsAGroup: bool = and {
    phasesNameGroupPlans(state.schedule),
    state.applied == 0 or state.phaseKeptTheOtherGroup,
  }

  // ADR 0039 §5: the floor of a group is not cancellable.
  val cancelNeverNamesTheDefault: bool = and {
    not(state.cancelPendingA) or not(state.plansA.exists(plan => isDefaultPlan(plan))),
    not(state.cancelPendingB) or not(state.plansB.exists(plan => isDefaultPlan(plan))),
  }

  // ADR 0039 §5: a resolved cancellation leaves the group on its default plan.
  val cancelFallsBackToTheDefault: bool =
    not(state.endedA)
      or (state.plansA.size() == 1 and state.plansA.exists(plan => isDefaultPlan(plan)))

  // ADR 0039 §5: a group with no default plan is left empty, and the account
  // keeps its add-ons.
  val noPlanAfterCancel: bool = not(state.endedB) or state.plansB.size() == 0

  // ADR 0039 §7: the clock stops at the boundary; the close is the only way past
  // it, and a terminal account has no period left to run.
  val noPeriodPastEnd: bool = not(state.open) or state.now <= state.periodEnd

  // ADR 0039 §7, ADR 0020: a terminal account has no plan, no add-on, no
  // cancellation waiting and no phase left to apply.
  val terminalHasNoIntent: bool = state.open or and {
    state.plansA.size() == 0,
    state.plansB.size() == 0,
    not(state.addOn),
    state.schedule == NoPhases,
    not(state.cancelPendingA),
    not(state.cancelPendingB),
  }

  val schedulesInvariant: bool = and {
    oneActivePerGroup,
    addOnsStack,
    addOnsSurviveGroupChange,
    phasesAreFuture,
    phasesAreOrdered,
    phaseNeverSkipsAGroup,
    cancelNeverNamesTheDefault,
    cancelFallsBackToTheDefault,
    noPlanAfterCancel,
    noPeriodPastEnd,
    terminalHasNoIntent,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  action attach(plan: PlanId): bool = all {
    canAttach(state, plan),
    state' = applyAttach(state, plan),
  }

  action addAddOn: bool = all {
    canAddAddOn(state),
    state' = applyAddAddOn(state),
  }

  action schedulePlan(plan: PlanId, at: int): bool = all {
    canSchedulePlan(state, plan, at),
    state' = applySchedulePlan(state, plan, at),
  }

  action withdrawPhase(plan: PlanId): bool = all {
    canWithdrawPhase(state, plan),
    state' = applyWithdrawPhase(state, plan),
  }

  action applyPhase: bool = all {
    canApplyPhase(state),
    state' = applyPhaseTo(state),
  }

  action cancelGroup(group: GroupId): bool = all {
    canCancelGroup(state, group),
    state' = applyCancelGroup(state, group),
  }

  action uncancelGroup(group: GroupId): bool = all {
    canUncancelGroup(state, group),
    state' = applyUncancelGroup(state, group),
  }

  action cancelNow(group: GroupId): bool = all {
    canCancelNow(state, group),
    state' = applyCancelNow(state, group),
  }

  action close: bool = all {
    canClose(state),
    state' = applyClose(state),
  }

  // Time. The clock stops at a due phase and at the boundary; the apply and the
  // close are the only ways past either.
  action tick: bool = all {
    state.open,
    state.now + 1 <= state.periodEnd,
    not(phaseDue(state)),
    state' = { ...state, now: state.now + 1 },
  }

  action step: bool = {
    nondet plan = PLANS.oneOf()
    nondet group = GROUPS.oneOf()
    nondet at = Set(state.now - 1, state.now, state.now + 1, state.now + 2, state.now + 3).oneOf()
    any {
      attach(plan),
      addAddOn,
      schedulePlan(plan, at),
      withdrawPhase(plan),
      applyPhase,
      cancelGroup(group),
      uncancelGroup(group),
      cancelNow(group),
      close,
      tick,
    }
  }

  action init: bool = all {
    state' = {
      now: 0,
      periodEnd: PERIOD_LENGTH,
      open: true,
      plansA: NO_PLANS,
      plansB: NO_PLANS,
      addOn: false,
      cancelPendingA: false,
      cancelPendingB: false,
      endedA: false,
      endedB: false,
      schedule: NoPhases,
      attaches: 0,
      addOns: 0,
      cancels: 0,
      cancelsNow: 0,
      uncancels: 0,
      withdrawals: 0,
      closes: 0,
      applied: 0,
      phaseKeptTheOtherGroup: true,
      lastPhase: A1,
    },
  }

  // ── witnesses ─────────────────────────────────────────────────────────────

  val attached: bool = state.plansA.size() + state.plansB.size() > 0

  val secondGroupAttached: bool = state.plansA.size() == 1 and state.plansB.size() == 1

  val addOnStacked: bool = state.addOn and anyPlan(state)

  val addOnSurvivedMove: bool = state.addOns > 0 and state.addOn and state.applied > 0

  val phasesScheduled: bool = phaseCount(state.schedule) == 1

  val twoPhasesScheduled: bool = phaseCount(state.schedule) == 2

  val phaseApplied: bool = state.applied > 0

  val twoPhasesApplied: bool = state.applied >= 2

  val phaseWithdrawn: bool = state.withdrawals > 0 and phaseCount(state.schedule) == 0

  val cancellationScheduled: bool = state.cancelPendingA or state.cancelPendingB

  val cancellationResolvedToDefault: bool =
    state.endedA and state.plansA.size() == 1

  val groupEnded: bool = state.endedB and state.plansB.size() == 0 and state.open

  val canceledNow: bool = state.cancelsNow > 0

  val uncanceled: bool = state.uncancels > 0 and state.open

  val closed: bool = not(state.open)
}
