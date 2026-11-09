// A Quint model of the plan-operation protocol: one active plan, a change
// scheduled for a boundary, a cancellation that wins the boundary, an immediate
// cancellation, and an uncancel that clears whichever intent is pending.
//
// This is the Phase 2 protocol. `standing.qnt` models the account's lifecycle;
// this models the plan move that precedes it. The two meet at `close`: a pending
// plan is applied and a pending cancellation ends the plan.
//
// A plan is a *generation*: an id and a version (ADR 0047). The catalogue has
// one current generation per id; a standing keeps the generation it bought, so
// a move to a newer one is an ordinary move and a standing may legitimately be
// older than the catalogue. A version this catalogue does not have is the one
// state the model refuses to reach.
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

  // One generation of a plan. The id is stable; the version is what a catalog
  // deploy bumps when the terms change (ADR 0047).
  type Generation = { plan: PlanId, version: int }

  // A plan that has not been bought yet, one that is running, and one that has
  // ended. An ended plan can be reactivated by a new attach.
  type Phase = NoPlan | Active | Canceled

  // The one change a plan may have waiting at its boundary. A phase carries the
  // generation it lands on, so a version move waits for the boundary like any
  // other non-upgrade.
  type Change = NoChange | Pending(Generation)

  // What an attach request becomes. The classification is pure; the action is
  // disabled when the request is a no-op.
  type AttachMode = Activate | Upgrade | Schedule | Noop

  type State = {
    now: int,
    phase: Phase,
    plan: PlanId,
    version: int,
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
    versionMoves: int,
  }

  // ── the catalogue ──────────────────────────────────────────────────────────

  pure val PLANS: Set[PlanId] = Set(Free, Pro, Scale)
  pure val PERIOD_LENGTH: int = 5

  pure def priceOf(plan: PlanId): int =
    if (plan == Free) 0 else if (plan == Pro) 20 else 40

  // The catalogue's current generation per plan. Pro is at its second
  // generation, so the model can hold an outdated standing and migrate it.
  pure def latestVersion(plan: PlanId): int =
    if (plan == Pro) 2 else 1

  pure def versionsOf(plan: PlanId): Set[int] = 1.to(latestVersion(plan))

  pure def generation(plan: PlanId, version: int): Generation =
    { plan: plan, version: version }

  pure def held(state: State): Generation =
    generation(state.plan, state.version)

  pure def sameGeneration(left: Generation, right: Generation): bool =
    left.plan == right.plan and left.version == right.version

  // A newer generation of the same plan is not an upgrade in price, so it waits
  // for the boundary unless the caller asks for it now. A rollback is a
  // downgrade, and the same rule keeps it at the boundary.
  pure def isUpgrade(current: Generation, target: Generation): bool =
    priceOf(target.plan) > priceOf(current.plan)

  pure def isDowngrade(current: Generation, target: Generation): bool =
    priceOf(target.plan) < priceOf(current.plan)
      or (target.plan == current.plan and target.version < current.version)

  pure def isVersionMove(current: Generation, target: Generation): bool =
    target.plan == current.plan and target.version != current.version

  pure def hasPending(change: Change): bool =
    match change {
      | NoChange => false
      | Pending(_) => true
    }

  pure def pendingGeneration(change: Change): Generation =
    match change {
      | NoChange => generation(Free, 1)
      | Pending(target) => target
    }

  pure def pendingPlan(change: Change): PlanId =
    pendingGeneration(change).plan

  pure def pendingVersion(change: Change): int =
    pendingGeneration(change).version

  // ── classification ─────────────────────────────────────────────────────────

  // A new plan is activated; a more expensive one is immediate; a cheaper one
  // (or a newer generation at the same price) is scheduled unless the caller
  // asks for it now; the same generation is a no-op.
  //
  // The request cannot turn an upgrade into a scheduled change: that would let a
  // caller keep a cheap plan after asking for an expensive one.
  pure def attachMode(state: State, target: Generation, immediate: bool): AttachMode =
    if (state.phase != Active) Activate
    else if (sameGeneration(held(state), target)) Noop
    else if (isUpgrade(held(state), target)) Upgrade
    else if (immediate) Upgrade
    else Schedule

  pure def canAttach(state: State, target: Generation, immediate: bool): bool =
    attachMode(state, target, immediate) != Noop

  pure def applyAttach(state: State, target: Generation, immediate: bool): State = {
    val mode = attachMode(state, target, immediate)
    val moved = isVersionMove(held(state), target)
    match mode {
      | Activate => {
          ...state,
          phase: Active,
          plan: target.plan,
          version: target.version,
          periodEnd: state.now + PERIOD_LENGTH,
          pending: NoChange,
          cancelAtPeriodEnd: false,
          attaches: state.attaches + 1,
          versionMoves: if (moved) state.versionMoves + 1 else state.versionMoves,
          reactivations: if (state.phase == NoPlan) state.reactivations else state.reactivations + 1,
        }
      | Upgrade => {
          ...state,
          plan: target.plan,
          version: target.version,
          pending: NoChange,
          attaches: state.attaches + 1,
          upgrades: state.upgrades + 1,
          versionMoves: if (moved) state.versionMoves + 1 else state.versionMoves,
        }
      | Schedule => {
          ...state,
          pending: Pending(target),
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
      val landing = pendingGeneration(state.pending)
      val moved = hasPending(state.pending) and isVersionMove(held(state), landing)
      {
        ...state,
        plan: landing.plan,
        version: landing.version,
        pending: NoChange,
        periodEnd: state.periodEnd + PERIOD_LENGTH,
        closes: state.closes + 1,
        versionMoves: if (moved) state.versionMoves + 1 else state.versionMoves,
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

  // An active plan is a real generation: a declared plan at a version this
  // catalogue states (ADR 0047).
  val activePlanIsKnown: bool =
    state.phase != Active
      or (PLANS.contains(state.plan)
        and state.version >= 1
        and state.version <= latestVersion(state.plan))

  // A scheduled change names a generation the catalogue states, so a phase
  // cannot invent a version the next deploy does not know.
  val pendingVersionIsKnown: bool =
    not(hasPending(state.pending))
      or (PLANS.contains(pendingPlan(state.pending))
        and pendingVersion(state.pending) >= 1
        and pendingVersion(state.pending) <= latestVersion(pendingPlan(state.pending)))

  // A scheduled change is never an upgrade. An upgrade is always immediate; a
  // request to defer one would be a different operation. A newer generation at
  // the same price is not an upgrade, so it may wait.
  val scheduledChangeIsNotAnUpgrade: bool =
    match state.pending {
      | NoChange => true
      | Pending(target) => not(isUpgrade(held(state), target))
    }

  // A pending change never names the generation that is already active. A
  // version move is a change; the same generation is the no-op (ADR 0047).
  val pendingIsNotCurrent: bool =
    match state.pending {
      | NoChange => true
      | Pending(target) => not(sameGeneration(held(state), target))
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
    pendingVersionIsKnown,
    scheduledChangeIsNotAnUpgrade,
    pendingIsNotCurrent,
    terminalHasNoIntent,
    noPlanHasNoIntent,
    noPeriodPastEnd,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  action attach(plan: PlanId, version: int, immediate: bool): bool = all {
    versionsOf(plan).contains(version),
    canAttach(state, generation(plan, version), immediate),
    state' = applyAttach(state, generation(plan, version), immediate),
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
    nondet version = versionsOf(plan).oneOf()
    nondet immediate = Set(false, true).oneOf()
    any {
      attach(plan, version, immediate),
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
      version: 1,
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
      versionMoves: 0,
    },
  }

  // ── witnesses ─────────────────────────────────────────────────────────────

  val active: bool = state.phase == Active

  val upgraded: bool = state.upgrades > 0 and state.phase == Active

  val downgradeScheduled: bool =
    state.downgrades > 0 and hasPending(state.pending)

  val pendingApplied: bool =
    state.closes > 0 and state.phase == Active and not(hasPending(state.pending))

  val versionMoved: bool = state.versionMoves > 0 and state.phase == Active

  val cancellationScheduled: bool =
    state.cancelAtPeriodEnd and state.phase == Active

  val canceledAtBoundary: bool = state.phase == Canceled and state.closes > 0

  val canceledImmediately: bool =
    state.phase == Canceled and state.immediateCancels > 0

  val reactivated: bool = state.reactivations > 0 and state.phase == Active

  val uncanceled: bool = state.uncancels > 0 and state.phase == Active
}
