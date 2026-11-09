// A Quint model of the plan-operation protocol: one active plan, a change
// scheduled for a boundary, a cancellation that wins the boundary, an immediate
// cancellation, and an uncancel that clears whichever intent is pending.
//
// This is the Phase 2 protocol. `standing.qnt` models the account's lifecycle;
// this models the plan move that precedes it. The two meet at `close`: a pending
// plan is applied and a pending cancellation ends the plan.
//
// Source correspondence:
//   attach              ↔ the classification an attach operation performs
//   upgrade             ↔ ChangeTier.command.ts (immediate)
//   scheduleDowngrade   ↔ ScheduleTierChange.command.ts
//   close               ↔ ClosePeriod.command.ts / PeriodEnded.command.ts
//   cancelAtBoundary    ↔ ScheduleCancellation.command.ts
//   uncancel            ↔ Resume.command.ts + WithdrawTierChange.command.ts
//   cancelImmediately   ↔ the immediate-cancel branch of an update operation
//   reactivate          ↔ Subscribe.command.ts on a terminal plan
//   tick                ↔ the platform clock
//
// Scope and the code divergences are in README.md beside this file. Add-ons and
// multiple plan groups are the next slice; this model keeps one plan because a
// second plan is a different invariant, not a second table row.
module plans {

  // ── types ──────────────────────────────────────────────────────────────────

  type PlanId = Free | Pro | Scale

  // A plan that has not been bought yet, one that is running, and one that has
  // ended. An ended plan can be reactivated by a new attach.
  type Phase = NoPlan | Active | Canceled

  // The one change a plan may have waiting at its boundary.
  type Change = NoChange | Pending(PlanId)

  // What an attach request becomes. The classification is pure; the action is
  // disabled when the request is a no-op.
  type AttachMode = Activate | Upgrade | Schedule | Noop

  type State = {
    now: int,
    phase: Phase,
    plan: PlanId,
    periodEnd: int,
    pending: Change,
    cancelAtPeriodEnd: bool,
    // History counters, so a witness can name the path that was taken.
    attaches: int,
    upgrades: int,
    downgrades: int,
    closes: int,
    immediateCancels: int,
    uncancels: int,
    reactivations: int,
  }

  // ── the catalogue ──────────────────────────────────────────────────────────

  pure val PLANS: Set[PlanId] = Set(Free, Pro, Scale)
  pure val PERIOD_LENGTH: int = 5

  pure def priceOf(plan: PlanId): int =
    if (plan == Free) 0 else if (plan == Pro) 20 else 40

  pure def isUpgrade(current: PlanId, target: PlanId): bool =
    priceOf(target) > priceOf(current)

  pure def isDowngrade(current: PlanId, target: PlanId): bool =
    priceOf(target) < priceOf(current)

  pure def hasPending(change: Change): bool =
    match change {
      | NoChange => false
      | Pending(_) => true
    }

  pure def pendingPlan(change: Change): PlanId =
    match change {
      | NoChange => Free
      | Pending(plan) => plan
    }

  // ── classification ─────────────────────────────────────────────────────────

  // A new plan is activated; a more expensive plan is immediate; a cheaper plan
  // is scheduled unless the caller asks for it now; the same plan is a no-op.
  // The request cannot turn an upgrade into a scheduled change: that would let a
  // caller keep a cheap plan after asking for an expensive one.
  pure def attachMode(state: State, plan: PlanId, immediate: bool): AttachMode =
    if (state.phase != Active) Activate
    else if (plan == state.plan) Noop
    else if (isUpgrade(state.plan, plan)) Upgrade
    else if (immediate) Upgrade
    else Schedule

  pure def canAttach(state: State, plan: PlanId, immediate: bool): bool =
    attachMode(state, plan, immediate) != Noop

  pure def applyAttach(state: State, plan: PlanId, immediate: bool): State = {
    val mode = attachMode(state, plan, immediate)
    match mode {
      | Activate => {
          ...state,
          phase: Active,
          plan: plan,
          periodEnd: state.now + PERIOD_LENGTH,
          pending: NoChange,
          cancelAtPeriodEnd: false,
          attaches: state.attaches + 1,
          reactivations: if (state.phase == NoPlan) state.reactivations else state.reactivations + 1,
        }
      | Upgrade => {
          ...state,
          plan: plan,
          pending: NoChange,
          attaches: state.attaches + 1,
          upgrades: state.upgrades + 1,
        }
      | Schedule => {
          ...state,
          pending: Pending(plan),
          attaches: state.attaches + 1,
          downgrades: state.downgrades + 1,
        }
      | Noop => state
    }
  }

  // ── the boundary ───────────────────────────────────────────────────────────

  // A cancellation wins the boundary. Otherwise a pending plan lands, and a
  // close with neither intent just rolls the period.
  pure def closePlan(state: State): State =
    if (state.cancelAtPeriodEnd)
      {
        ...state,
        phase: Canceled,
        pending: NoChange,
        cancelAtPeriodEnd: false,
        closes: state.closes + 1,
      }
    else {
      val nextPlan =
        match state.pending {
          | NoChange => state.plan
          | Pending(plan) => plan
        }
      {
        ...state,
        plan: nextPlan,
        pending: NoChange,
        periodEnd: state.periodEnd + PERIOD_LENGTH,
        closes: state.closes + 1,
      }
    }

  pure def canClose(state: State): bool =
    state.phase == Active and state.now >= state.periodEnd

  pure def canCancel(state: State): bool =
    state.phase == Active and not(state.cancelAtPeriodEnd)

  pure def canUncancel(state: State): bool =
    state.phase == Active and (state.cancelAtPeriodEnd or hasPending(state.pending))

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // An active plan is a real plan.
  val activePlanIsKnown: bool =
    state.phase != Active or PLANS.contains(state.plan)

  // A scheduled change is a downgrade. An upgrade is always immediate; a
  // request to defer one would be a different operation.
  val scheduledChangeIsADowngrade: bool =
    match state.pending {
      | NoChange => true
      | Pending(plan) => isDowngrade(state.plan, plan)
    }

  // A pending change never names the plan that is already active.
  val pendingIsNotCurrent: bool =
    match state.pending {
      | NoChange => true
      | Pending(plan) => plan != state.plan
    }

  // A canceled plan carries no future intent. The close and the immediate
  // cancellation both clear the pending change and the cancellation flag.
  val terminalHasNoIntent: bool =
    state.phase != Canceled
      or (state.pending == NoChange and not(state.cancelAtPeriodEnd))

  // A plan that has never been bought carries no intent either.
  val noPlanHasNoIntent: bool =
    state.phase != NoPlan
      or (state.pending == NoChange and not(state.cancelAtPeriodEnd))

  // The period is open until the close. The clock stops at the boundary, so a
  // running plan is never overdue.
  val noPeriodPastEnd: bool =
    state.phase != Active or state.now <= state.periodEnd

  val plansInvariant: bool = and {
    activePlanIsKnown,
    scheduledChangeIsADowngrade,
    pendingIsNotCurrent,
    terminalHasNoIntent,
    noPlanHasNoIntent,
    noPeriodPastEnd,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  action attach(plan: PlanId, immediate: bool): bool = all {
    canAttach(state, plan, immediate),
    state' = applyAttach(state, plan, immediate),
  }

  action cancelAtBoundary: bool = all {
    canCancel(state),
    state' = { ...state, cancelAtPeriodEnd: true },
  }

  action uncancel: bool = all {
    canUncancel(state),
    state' = {
      ...state,
      pending: NoChange,
      cancelAtPeriodEnd: false,
      uncancels: state.uncancels + 1,
    },
  }

  // An immediate cancellation ends the plan now. It does not carry a pending
  // change: both are intents, and the terminal state has neither.
  action cancelImmediately: bool = all {
    state.phase == Active,
    state' = {
      ...state,
      phase: Canceled,
      pending: NoChange,
      cancelAtPeriodEnd: false,
      immediateCancels: state.immediateCancels + 1,
    },
  }

  action close: bool = all {
    canClose(state),
    state' = closePlan(state),
  }

  // Time. The clock stops at the boundary; the close is the only way past it.
  action tick: bool = all {
    state.phase == Active,
    state.now + 1 <= state.periodEnd,
    state' = { ...state, now: state.now + 1 },
  }

  action step: bool = {
    nondet plan = PLANS.oneOf()
    nondet immediate = Set(false, true).oneOf()
    any {
      attach(plan, immediate),
      cancelAtBoundary,
      uncancel,
      cancelImmediately,
      close,
      tick,
    }
  }

  action init: bool = all {
    state' = {
      now: 0,
      phase: NoPlan,
      plan: Free,
      periodEnd: PERIOD_LENGTH,
      pending: NoChange,
      cancelAtPeriodEnd: false,
      attaches: 0,
      upgrades: 0,
      downgrades: 0,
      closes: 0,
      immediateCancels: 0,
      uncancels: 0,
      reactivations: 0,
    },
  }

  // ── witnesses ─────────────────────────────────────────────────────────────

  val active: bool = state.phase == Active

  val upgraded: bool = state.upgrades > 0 and state.phase == Active

  val downgradeScheduled: bool =
    state.downgrades > 0 and hasPending(state.pending)

  val pendingApplied: bool =
    state.closes > 0 and state.phase == Active and not(hasPending(state.pending))

  val cancellationScheduled: bool =
    state.cancelAtPeriodEnd and state.phase == Active

  val canceledAtBoundary: bool = state.phase == Canceled and state.closes > 0

  val canceledImmediately: bool =
    state.phase == Canceled and state.immediateCancels > 0

  val reactivated: bool = state.reactivations > 0 and state.phase == Active

  val uncanceled: bool = state.uncancels > 0 and state.phase == Active
}
