// The named scenarios for customer controls. Each run is a path the code must
// be able to take, and each expectation is one line of ADR 0038 the code
// follows.
//
// A `.fail()` must be the last step of a run: Quint's test runner does not keep
// the state after a step it proved disabled. The refusal branch of a command is
// therefore its own run (`refuse`), and the accept-set it refuses is a separate
// run ending in `track(...).fail()`.
module controls_test {
  import controls.* from "./controls"

  // A ceiling refuses the spend that would pass it and leaves the billed total
  // where it was. A refusal is the command's other branch.
  run limitRefusesTest =
    init
      .then(setControls(10))
      .then(track(5))
      .expect(state.billed == 10)
      .then(refuse(1))
      .expect(state.billed == 10)
      .expect(state.refusals == 1)
      .expect(controlsInvariant)

  // The accepted branch is disabled once a spend would pass the ceiling.
  run limitDisablesTrackTest =
    init
      .then(setControls(10))
      .then(track(5))
      .then(track(1).fail())

  // A refusal leaves the standing good: a ceiling is not dunning (ADR 0038).
  run limitDoesNotMoveStandingTest =
    init
      .then(setControls(10))
      .then(track(5))
      .then(refuse(1))
      .expect(state.standing == Good)
      .expect(controlsInvariant)

  // No ceiling is the opt-in: every track is accepted and nothing refuses.
  run noLimitNeverRefusesTest =
    init
      .then(track(5))
      .then(track(5))
      .expect(state.billed == 20)
      .expect(state.refusals == 0)
      .expect(controlsInvariant)

  // A very large spend records when no ceiling is set, so "a limit refuses" is
  // not accidentally "a track never records".
  run noLimitRecordsEveryAmountTest =
    init
      .then(track(100))
      .expect(state.billed == 200)
      .expect(controlsInvariant)

  // Clearing the ceiling lets the next spend through; the earlier refusal
  // stays in the history.
  run clearControlsAllowsAgainTest =
    init
      .then(setControls(2))
      .then(track(1))
      .then(refuse(1))
      .expect(state.refusals == 1)
      .then(clearControls)
      .then(track(1))
      .expect(state.billed == 4)
      .expect(not(state.hasLimit))
      .expect(controlsInvariant)

  // A ceiling of zero is a real control, not the absence of one: it bills
  // nothing and refuses the first unit.
  run ceilingOfZeroBillsNothingTest =
    init
      .then(setControls(0))
      .then(refuse(1))
      .expect(state.billed == 0)
      .expect(state.refusals == 1)
      .expect(controlsInvariant)

  run ceilingOfZeroRefusesTrackTest =
    init
      .then(setControls(0))
      .then(track(1).fail())

  // A ceiling may be lowered under money already billed: it stops new spend,
  // it never unbills history.
  run lowerLimitBelowBillTest =
    init
      .then(setControls(10))
      .then(track(5))
      .expect(state.billed == 10)
      .then(setControls(4))
      .then(refuse(1))
      .expect(state.billed == 10)
      .expect(state.limit == 4)
      .expect(state.refusals == 1)
      .expect(controlsInvariant)

  run lowerLimitDisablesTrackTest =
    init
      .then(setControls(10))
      .then(track(5))
      .then(setControls(4))
      .then(track(1).fail())

  // An alert waits for its threshold, fires once, and never refuses anything.
  run alertWaitsForThresholdTest =
    init
      .then(setControls(100))
      .then(track(4))
      .then(fireAlert.fail())

  run alertFiresAtThresholdTest =
    init
      .then(setControls(100))
      .then(track(5))
      .then(fireAlert)
      .expect(state.fired)
      .expect(state.alertFires == 1)
      .expect(controlsInvariant)

  run alertFiresOnceTest =
    init
      .then(setControls(100))
      .then(track(5))
      .then(fireAlert)
      .then(fireAlert.fail())

  // An alert is evidence: the spend after it still records.
  run alertNeverBlocksTest =
    init
      .then(setControls(100))
      .then(track(5))
      .then(fireAlert)
      .then(track(1))
      .expect(state.used == 6)
      .expect(state.billed == 12)
      .expect(controlsInvariant)

  // A close resets the alert latch and the period's used count; the ceiling is
  // still the customer's.
  run alertsResetAtCloseTest =
    init
      .then(setControls(100))
      .then(track(5))
      .then(fireAlert)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(not(state.fired))
      .expect(state.alertFires == 0)
      .expect(state.used == 0)
      .expect(state.billed == 0)
      .expect(state.hasLimit)
      .expect(state.limit == 100)
      .expect(state.hadLimitAtClose)
      .then(track(5))
      .then(fireAlert)
      .expect(state.alertFires == 1)
      .expect(controlsInvariant)

  // A ceiling is not the period's: a close keeps it exactly where it was.
  run ceilingSurvivesCloseTest =
    init
      .then(setControls(10))
      .then(track(1))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.hasLimit)
      .expect(state.limit == 10)
      .expect(state.limitAtClose == 10)
      .expect(state.billed == 0)
      .expect(controlsInvariant)

  // Spending exactly to the ceiling is allowed; the next unit is not.
  run spendsToTheCeilingTest =
    init
      .then(setControls(4))
      .then(track(2))
      .expect(state.billed == 4)
      .then(refuse(1))
      .expect(state.refusals == 1)
      .expect(controlsInvariant)

  // A close before the boundary is disabled, and the clock cannot walk past
  // the boundary it owns.
  run closeBeforeBoundaryFailsTest =
    init
      .then(closePeriod.fail())

  run tickStopsAtTheBoundaryTest =
    init
      .then(5.reps(_ => tick))
      .then(tick.fail())

  // A refusal does not consume the period's usage: the refused units are not
  // in `used`, so an alert counts what actually ran.
  run refusalDoesNotUseTest =
    init
      .then(setControls(2))
      .then(refuse(4))
      .expect(state.used == 0)
      .expect(state.billed == 0)
      .expect(controlsInvariant)
}
