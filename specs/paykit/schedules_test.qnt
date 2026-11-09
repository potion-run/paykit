// Named scenarios for `schedules.qnt`: a second group, an add-on that stacks, a
// two-phase schedule, a cancellation that drops a phase and resolves to the
// default, an add-on that survives the change, and a terminal account that
// refuses every move.
//
// A `.fail()` step ends the run because a refused action leaves no state behind,
// so each refusal gets its own run with the failing step last.
//
// Run: `quint test specs/paykit/schedules_test.qnt --main=schedules_test`
module schedules_test {

  import schedules.* from "./schedules"

  // A second group attaches beside the first; neither replaces the other.
  run secondGroupTest =
    init
      .then(attach(A1))
      .expect(state.plansA == Set(A1) and state.plansB == Set())
      .then(attach(B1))
      .expect(state.plansA == Set(A1) and state.plansB == Set(B1))
      .expect(schedulesInvariant)

  // A move inside a group replaces the plan instead of stacking a second one.
  run replaceWithinGroupTest =
    init
      .then(attach(A1))
      .then(attach(A2))
      .expect(state.plansA == Set(A2) and state.plansA.size() == 1)
      .expect(state.plansB == Set())
      .expect(schedulesInvariant)

  // An add-on stacks beside the plan and fills no group's slot.
  run addOnStacksTest =
    init
      .then(attach(A1))
      .then(addAddOn)
      .expect(state.addOn and state.plansA == Set(A1) and state.plansB == Set())
      .expect(state.addOns == 1)
      .expect(schedulesInvariant)

  // A second add-on is refused while the first is attached.
  run addOnAttachesOnceTest =
    init
      .then(addAddOn)
      .expect(state.addOn and state.addOns == 1)
      .then(addAddOn.fail())

  // Two phases apply in order, each to its own group.
  run twoPhaseScheduleTest =
    init
      .then(attach(A1))
      .then(schedulePlan(A2, 2))
      .then(schedulePlan(B1, 3))
      .expect(phaseCount(state.schedule) == 2)
      .then(2.reps(_ => tick))
      .expect(state.now == 2 and phaseDue(state))
      .then(applyPhase)
      .expect(state.plansA == Set(A2) and state.plansB == Set())
      .expect(phaseCount(state.schedule) == 1)
      .then(1.reps(_ => tick))
      .then(applyPhase)
      .expect(state.plansA == Set(A2) and state.plansB == Set(B1))
      .expect(state.applied == 2 and state.lastPhase == B1)
      .expect(phaseCount(state.schedule) == 0)
      .expect(schedulesInvariant)

  // A cancellation drops the phase the group still had waiting.
  run cancellationDropsPhaseTest =
    init
      .then(attach(A2))
      .then(schedulePlan(A1, 2))
      .expect(phaseCount(state.schedule) == 1)
      .then(cancelGroup(A))
      .expect(phaseCount(state.schedule) == 0)
      .expect(state.cancelPendingA)
      .expect(schedulesInvariant)

  // The boundary resolves a cancellation to the group's default plan.
  run cancelFallsBackToDefaultTest =
    init
      .then(attach(A2))
      .then(cancelGroup(A))
      .then(5.reps(_ => tick))
      .then(close)
      .expect(state.plansA == Set(A1))
      .expect(not(state.cancelPendingA) and state.endedA)
      .expect(state.open)
      .expect(schedulesInvariant)

  // An uncancel withdraws the cancellation, and the plan survives the boundary.
  run uncancelKeepsThePlanTest =
    init
      .then(attach(A2))
      .then(cancelGroup(A))
      .then(uncancelGroup(A))
      .expect(not(state.cancelPendingA) and state.uncancels == 1)
      .then(5.reps(_ => tick))
      .then(close)
      .expect(state.plansA == Set(A2))
      .expect(not(state.endedA))
      .expect(schedulesInvariant)
      .then(uncancelGroup(A).fail())

  // A group with no default plan is left empty, and the add-on survives.
  run groupEndsAddOnStaysTest =
    init
      .then(attach(A1))
      .then(attach(B1))
      .then(addAddOn)
      .then(cancelGroup(B))
      .then(5.reps(_ => tick))
      .then(close)
      .expect(state.plansB == Set() and state.endedB)
      .expect(state.plansA == Set(A1) and state.addOn and state.open)
      .expect(schedulesInvariant)

  // An add-on survives a phase that moves the group beside it.
  run addOnSurvivesPhaseTest =
    init
      .then(attach(B1))
      .then(addAddOn)
      .then(schedulePlan(B2, 1))
      .then(1.reps(_ => tick))
      .then(applyPhase)
      .expect(state.plansB == Set(B2) and state.addOn)
      .expect(schedulesInvariant)

  // An immediate cancellation resolves the group now, with the same fallback.
  run cancelNowTest =
    init
      .then(attach(A2))
      .then(cancelNow(A))
      .expect(state.plansA == Set(A1) and state.endedA)
      .expect(schedulesInvariant)
      .then(cancelNow(A).fail())

  // The floor of a group is not cancellable at the boundary.
  run defaultIsNotCancelableTest =
    init
      .then(attach(A1))
      .then(cancelGroup(A).fail())

  // The floor of a group is not cancellable immediately either.
  run defaultIsNotCancelableNowTest =
    init
      .then(attach(A1))
      .then(cancelNow(A).fail())

  // A terminal account has no plans, no add-on and no period.
  run terminalAccountTest =
    init
      .then(attach(B1))
      .then(cancelGroup(B))
      .then(5.reps(_ => tick))
      .then(close)
      .expect(not(state.open))
      .expect(state.plansA == Set() and state.plansB == Set())
      .expect(schedulesInvariant)
      .then(attach(A1).fail())

  // A terminal account cannot attach an add-on.
  run terminalAddOnTest =
    init
      .then(attach(B1))
      .then(cancelGroup(B))
      .then(5.reps(_ => tick))
      .then(close)
      .then(addAddOn.fail())

  // A terminal account cannot schedule a phase.
  run terminalScheduleTest =
    init
      .then(attach(B1))
      .then(cancelGroup(B))
      .then(5.reps(_ => tick))
      .then(close)
      .then(schedulePlan(A1, 1).fail())

  // A terminal account's clock does not move.
  run terminalTickTest =
    init
      .then(attach(B1))
      .then(cancelGroup(B))
      .then(5.reps(_ => tick))
      .then(close)
      .then(tick.fail())

  // A phase is future-only.
  run scheduleRefusesPastTest =
    init
      .then(schedulePlan(A1, 0).fail())

  // At most one phase per instant.
  run scheduleRefusesSameInstantTest =
    init
      .then(schedulePlan(A1, 2))
      .then(schedulePlan(B1, 2).fail())

  // At most two phases per schedule.
  run scheduleRefusesFullTest =
    init
      .then(schedulePlan(A1, 2))
      .then(schedulePlan(B1, 3))
      .then(schedulePlan(B2, 4).fail())

  // A phase names a group's plan, never the add-on.
  run scheduleRefusesAddOnTest =
    init
      .then(schedulePlan(AddOn, 2).fail())

  // A withdrawal drops a phase, and a second withdrawal of the same plan is
  // refused.
  run withdrawPhaseTest =
    init
      .then(attach(A1))
      .then(schedulePlan(A2, 2))
      .then(withdrawPhase(A2))
      .expect(phaseCount(state.schedule) == 0)
      .expect(state.withdrawals == 1)
      .then(withdrawPhase(A2).fail())

  // A move drops the phases its own group had waiting, and leaves the other
  // group's phases alone.
  run attachDropsOwnPhasesTest =
    init
      .then(attach(A1))
      .then(schedulePlan(A2, 2))
      .then(schedulePlan(B1, 3))
      .then(attach(A2))
      .expect(state.plansA == Set(A2))
      .expect(phaseCount(state.schedule) == 1)
      .expect(state.schedule == OnePhase({ plan: B1, at: 3 }))
      .expect(schedulesInvariant)

  // The clock stops at a due phase; the apply is the only way past it.
  run clockStopsAtPhaseTest =
    init
      .then(attach(A1))
      .then(schedulePlan(A2, 2))
      .then(2.reps(_ => tick))
      .expect(state.now == 2)
      .then(tick.fail())

  // The phase applies at its instant and the clock moves again.
  run phaseAppliesAtItsInstantTest =
    init
      .then(attach(A1))
      .then(schedulePlan(A2, 2))
      .then(2.reps(_ => tick))
      .then(applyPhase)
      .then(tick)
      .expect(state.now == 3 and state.plansA == Set(A2))
      .expect(schedulesInvariant)

  // The clock stops at the boundary; the close is the only way past it.
  run clockStopsAtBoundaryTest =
    init
      .then(attach(A1))
      .then(5.reps(_ => tick))
      .expect(state.now == PERIOD_LENGTH)
      .then(tick.fail())

  // The close rolls the period and keeps the plan.
  run closeRollsThePeriodTest =
    init
      .then(attach(A1))
      .then(5.reps(_ => tick))
      .then(close)
      .expect(state.periodEnd == 2 * PERIOD_LENGTH)
      .expect(state.plansA == Set(A1) and state.open)
      .expect(schedulesInvariant)
}
