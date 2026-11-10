// Named scenarios for `plans.qnt`. A `.fail()` step ends the run because a
// refused action leaves no state behind.
//
// Run: `quint test specs/paykit/plans_test.qnt --main=plans_test`
module plans_test {

  import plans.* from "./plans"

  run activateTest =
    init
      .then(attach(Free, 1, false))
      .expect(state.phase == Active and state.plan == Free)
      .expect(plansInvariant)

  // Attaching the plan already running is a no-op, so the action is disabled.
  run samePlanIsNoopTest =
    init
      .then(attach(Free, 1, false))
      .then(attach(Free, 1, false).fail())

  // A more expensive plan is immediate even when the caller did not ask for it.
  run upgradeIsImmediateTest =
    init
      .then(attach(Free, 1, false))
      .then(attach(Pro, 2, false))
      .expect(state.plan == Pro and state.phase == Active)
      .expect(state.upgrades == 1 and not(hasPending(state.pending)))
      .expect(plansInvariant)

  // A cheaper plan waits for the boundary.
  run downgradeIsScheduledTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Free, 1, false))
      .expect(state.plan == Pro)
      .expect(hasPending(state.pending) and pendingPlan(state.pending) == Free)
      .expect(state.downgrades == 1)
      .expect(plansInvariant)

  // The caller can ask for a downgrade now; it applies immediately.
  run downgradeImmediateTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Free, 1, true))
      .expect(state.plan == Free and not(hasPending(state.pending)))
      .expect(plansInvariant)

  // The boundary applies the pending downgrade.
  run pendingAppliedTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Free, 1, false))
      .then(5.reps(_ => tick))
      .then(close)
      .expect(state.phase == Active and state.plan == Free)
      .expect(not(hasPending(state.pending)))
      .expect(state.closes == 1)
      .expect(plansInvariant)

  // A cancellation wins the boundary and drops the pending change.
  run cancellationWinsTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Free, 1, false))
      .then(cancelAtBoundary)
      .then(5.reps(_ => tick))
      .then(close)
      .expect(state.phase == Canceled)
      .expect(not(hasPending(state.pending)) and not(state.cancelAtPeriodEnd))
      .expect(plansInvariant)

  // An immediate cancellation also drops the pending change.
  run immediateCancellationTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Free, 1, false))
      .then(cancelImmediately)
      .expect(state.phase == Canceled)
      .expect(not(hasPending(state.pending)) and not(state.cancelAtPeriodEnd))
      .expect(plansInvariant)

  // An uncancel removes a pending downgrade.
  run uncancelPendingTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Free, 1, false))
      .then(uncancel)
      .expect(not(hasPending(state.pending)))
      .expect(state.plan == Pro)
      .expect(plansInvariant)

  // An uncancel clears a pending cancellation.
  run uncancelCancellationTest =
    init
      .then(attach(Pro, 2, false))
      .then(cancelAtBoundary)
      .then(uncancel)
      .expect(not(state.cancelAtPeriodEnd))
      .expect(plansInvariant)

  // A canceled plan can be bought again; the new attach opens a new period.
  run reactivateTest =
    init
      .then(attach(Pro, 2, false))
      .then(cancelImmediately)
      .then(attach(Scale, 1, false))
      .expect(state.phase == Active and state.plan == Scale)
      .expect(state.reactivations == 1)
      .expect(plansInvariant)

  // A newer generation at the same price is a move, not a no-op; by default it
  // waits for the boundary (ADR 0047).
  run versionMoveIsScheduledTest =
    init
      .then(attach(Pro, 1, false))
      .then(attach(Pro, 2, false))
      .expect(state.plan == Pro and state.version == 1)
      .expect(hasPending(state.pending) and pendingVersion(state.pending) == 2)
      .expect(state.downgrades == 1 and state.versionMoves == 0)
      .expect(plansInvariant)

  // The caller can take the newer generation now.
  run versionMoveImmediateTest =
    init
      .then(attach(Pro, 1, false))
      .then(attach(Pro, 2, true))
      .expect(state.plan == Pro and state.version == 2)
      .expect(not(hasPending(state.pending)))
      .expect(state.versionMoves == 1)
      .expect(plansInvariant)

  // The boundary lands the scheduled generation, and the move is recorded.
  run versionMoveAtBoundaryTest =
    init
      .then(attach(Pro, 1, false))
      .then(attach(Pro, 2, false))
      .then(5.reps(_ => tick))
      .then(close)
      .expect(state.plan == Pro and state.version == 2)
      .expect(state.versionMoves == 1)
      .expect(plansInvariant)

  // The same generation is a no-op.
  run sameGenerationIsNoopTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Pro, 2, false).fail())

  // A version only moves forward: the held plan at an older generation is
  // refused when it asks for the boundary (PlanVersionStale, ADR 0047 §5).
  run staleVersionIsRefusedTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Pro, 1, false).fail())

  // The immediate request is refused by the same rule, not treated as a
  // deliberate downgrade.
  run staleVersionImmediateIsRefusedTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Pro, 1, true).fail())

  // A generation the catalogue does not state is not attachable.
  run unknownGenerationIsRefusedTest =
    init
      .then(attach(Pro, 2, false))
      .then(attach(Pro, 3, false).fail())

  // The clock stops at the boundary; the close is the only way past it.
  run clockStopsAtBoundaryTest =
    init
      .then(attach(Pro, 2, false))
      .then(5.reps(_ => tick))
      .expect(state.now == PERIOD_LENGTH)
      .then(tick.fail())

  run closeAfterBoundaryTest =
    init
      .then(attach(Pro, 2, false))
      .then(5.reps(_ => tick))
      .then(close)
      .expect(state.periodEnd == 2 * PERIOD_LENGTH)
      .expect(plansInvariant)
}
