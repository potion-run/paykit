// Named scenarios for `windows.qnt`. Each run is a claim about the accept-set
// and the state a boundary leaves. A `.fail()` step ends the run because a
// refused action leaves no state behind.
//
// Run: `quint test specs/paykit/windows_test.qnt --main=windows_test`
module windows_test {

  import windows.* from "./windows"

  // ── the independent window ─────────────────────────────────────────────────

  run trackTest =
    init
      .then(track(Messages, 6))
      .expect(state.windows.get(Messages).remaining == 4)
      .expect(windowsInvariant)

  run blockingRefusalTest =
    init
      .then(track(Messages, 11).fail())

  // The boundary resets from the boundary that was recorded, not from a caller's
  // idea of it.
  run dailyResetTest =
    init
      .then(track(Messages, 6))
      .then(tick)
      .then(resetWindow(Messages, 1))
      .expect(state.windows.get(Messages).lastResetAt == 1)
      .expect(state.windows.get(Messages).boundary == 2)
      .expect(state.windows.get(Messages).remaining == 14)
      .expect(state.resets == 1)
      .expect(windowsInvariant)

  // The carry is capped: a full window rolls at most four units, not ten.
  run carryCapTest =
    init
      .then(tick)
      .then(resetWindow(Messages, 1))
      .expect(state.windows.get(Messages).remaining == 14)
      .expect(windowsInvariant)

  // A reset before the boundary, or for a boundary the standing did not record,
  // is disabled.
  run resetBeforeBoundaryTest =
    init
      .then(resetWindow(Messages, 1).fail())

  run staleBoundaryTest =
    init
      .then(tick)
      .then(resetWindow(Messages, 2).fail())

  // A late fire advances the chain from where it fired, not from where the
  // boundary was. That is the deployment's choice; the model records it.
  run lateResetTest =
    init
      .then(3.reps(_ => tick))
      .then(resetWindow(Messages, 1))
      .expect(state.windows.get(Messages).lastResetAt == 1)
      .expect(state.windows.get(Messages).boundary == 2)
      .expect(state.now == 3)
      .expect(windowsInvariant)

  // A period-owned window is the close's job, so its own reset is disabled.
  run periodWindowHasNoOwnResetTest =
    init
      .then(resetWindow(Requests, 5).fail())

  // ── the period close ───────────────────────────────────────────────────────

  // The close resets the monthly window and leaves the daily one exactly where
  // it was. The daily one is on its own clock.
  run closeResetsOnlyItsWindowsTest =
    init
      .then(track(Messages, 3))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.windows.get(Messages).remaining == 7)
      .expect(state.windows.get(Messages).lastResetAt == 0)
      .expect(state.windows.get(Requests).lastResetAt == PERIOD_LENGTH)
      .expect(state.windows.get(Requests).boundary == 2 * PERIOD_LENGTH)
      .expect(state.periodEnd == 2 * PERIOD_LENGTH)
      .expect(windowsInvariant)

  run closeBeforeBoundaryTest =
    init
      .then(closePeriod.fail())

  // ── a quantity is set, not spent ───────────────────────────────────────────

  run setQuantityTest =
    init
      .then(setQuantity(7))
      .expect(state.seats.purchased == 7)
      .expect(windowsInvariant)

  run quantityCapTest =
    init
      .then(setQuantity(11).fail())

  run quantityNegativeTest =
    init
      .then(setQuantity(-1).fail())

  // A tier change keeps the quantity, raises it to a bigger free grant, and
  // refuses a move whose cap is below what the account already holds.
  run quantityTierChangeTest =
    init
      .then(setQuantity(7))
      .then(changeTierCap(10, 4))
      .expect(state.seats.purchased == 7 and state.seats.included == 4)
      .then(changeTierCap(12, 8))
      .expect(state.seats.purchased == 8 and state.seats.included == 8)
      .expect(windowsInvariant)

  // A plan change never removes a purchased seat. The account is over the new
  // purchase cap until it buys down; occupied seats are untouched.
  run quantityDowngradeBelowHeldTest =
    init
      .then(setQuantity(7))
      .then(setUsage(5))
      .then(changeTierCap(5, 2))
      .expect(state.seats.purchased == 7 and state.seats.cap == 5)
      .expect(seatBalance(state.seats) == 2)
      .expect(windowsInvariant)

  // Lowering the purchase below occupancy leaves a negative balance and does
  // not remove an occupied seat.
  run purchaseBelowOccupancyTest =
    init
      .then(setQuantity(10))
      .then(setUsage(10))
      .then(setQuantity(3))
      .expect(state.seats.purchased == 3 and state.seats.occupied == 10)
      .expect(seatBalance(state.seats) == -7)
      .expect(windowsInvariant)

  // Occupancy can be set independently and never changes the purchase.
  run occupancyTest =
    init
      .then(setQuantity(8))
      .then(setUsage(6))
      .expect(state.seats.purchased == 8 and state.seats.occupied == 6)
      .expect(seatBalance(state.seats) == 2)
      .expect(windowsInvariant)

  // A close does not reset a seat: a quantity is not a counter.
  run seatSurvivesCloseTest =
    init
      .then(setQuantity(7))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.seats.purchased == 7)
      .expect(windowsInvariant)

  // ── the top-up budget and its rungs ────────────────────────────────────────

  run topUpBudgetTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .expect(state.topUpAttempts == 1 and state.topUpEpisode == 1)
      .expect(state.rungs.size() == 1)
      .then(failTopUp)
      .expect(state.topUpAttempts == 2 and state.rungs.size() == 1)
      .then(failTopUp)
      .expect(state.topUpAttempts == 3 and state.rungs.size() == 0)
      .expect(windowsInvariant)

  // The budget is two retries after the first attempt: a fourth failure is
  // not a rung the tier allows.
  run topUpBudgetExhaustedTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(failTopUp)
      .then(failTopUp)
      .then(failTopUp.fail())

  // A rung fires only at its deadline, while the pool is under the line.
  run rungBeforeDeadlineTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(fireAnyRung.fail())

  run rungFireTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(2.reps(_ => tick))
      .then(fireAnyRung)
      .expect(state.firedRungs == 1 and state.rungs.size() == 0)
      .expect(windowsInvariant)

  // A success clears the queue and resets the budget. A stale rung from the
  // old episode is not merely refused, it is gone.
  run purchaseClearsRungsTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(buyTopUp)
      .expect(state.topUpAttempts == 0 and state.rungs.size() == 0)
      .expect(hasCooldown(state.cooldown))
      .expect(windowsInvariant)

  // A new episode's rung is the only one the queue carries.
  run newEpisodeRungTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(buyTopUp)
      .then(spendCredits(9))
      .then(failTopUp)
      .expect(state.topUpEpisode == 2 and state.topUpAttempts == 1)
      .expect(state.rungs.size() == 1)
      .then(3.reps(_ => tick))
      .then(cooldownElapsed)
      .then(fireAnyRung)
      .expect(state.firedRungs == 1)
      .expect(windowsInvariant)

  // A rung is not live while a cooldown is open, even at its deadline.
  run cooldownBlocksRungTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(buyTopUp)
      .then(spendCredits(9))
      .then(failTopUp)
      .then(2.reps(_ => tick))
      .then(fireAnyRung.fail())

  // ── the cooldown ───────────────────────────────────────────────────────────

  run cooldownEarlyTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(buyTopUp)
      .expect(hasCooldown(state.cooldown))
      .then(cooldownElapsed.fail())

  run cooldownDeadlineTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(buyTopUp)
      .expect(hasCooldown(state.cooldown))
      .then(3.reps(_ => tick))
      .then(cooldownElapsed)
      .expect(not(hasCooldown(state.cooldown)))
      .expect(windowsInvariant)

  // ── terminality ────────────────────────────────────────────────────────────

  // An ended standing has no window left to reset, no quantity to set, and no
  // refill to buy. Every one of those is a disabled action.
  run endedStopsTheBoundaryTest =
    init
      .then(endStanding)
      .then(resetWindow(Messages, 1).fail())

  run endedStopsTheCloseTest =
    init
      .then(endStanding)
      .then(closePeriod.fail())

  run endedStopsTheQuantityTest =
    init
      .then(endStanding)
      .then(setQuantity(5).fail())

  run endedStopsTheRefillTest =
    init
      .then(endStanding)
      .then(buyTopUp.fail())

  // A scheduled cooldown deadline is a cleanup, not a boundary: it may still
  // clear after the standing ends.
  run endedAllowsCooldownCleanupTest =
    init
      .then(spendCredits(18))
      .then(failTopUp)
      .then(buyTopUp)
      .then(endStanding)
      .then(3.reps(_ => tick))
      .then(cooldownElapsed)
      .expect(not(hasCooldown(state.cooldown)))
      .expect(windowsInvariant)
}
