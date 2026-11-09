// Named scenarios for `paykit.qnt`. Each one is a claim about the accept-set: the
// paths that must exist, and the refusals that must hold. `quint test` fails a
// scenario whose action cannot fire, which is what keeps an action from going
// dead while the invariants stay green.
//
// A `.fail()` step leaves no state behind, so a scenario that expects to be
// refused ends on that step: the refusal is the last thing a trace can assert.
//
// Run: `quint test specs/paykit/paykit_test.qnt --main=paykit_test`
module paykit_test {

  import paykit.* from "./paykit"

  // ── activation ─────────────────────────────────────────────────────────────

  run subscribeTest =
    init
      .then(subscribe)
      .expect(state.status == Active and state.credits == CREDITS_GRANTED)
      .expect(paykitInvariant)

  // A second activation on an open standing is `AlreadySubscribed`: the action
  // is disabled, not a second grant.
  run subscribeTwiceTest =
    init
      .then(subscribe)
      .expect(state.credits == CREDITS_GRANTED)
      .then(subscribe.fail())

  // ── a counted allowance ────────────────────────────────────────────────────

  run trackWithinIncludedTest =
    init
      .then(subscribe)
      .then(trackUsage("messages", 4))
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED - 4)
      .expect(state.used.get("messages") == 4)
      .expect(paykitInvariant)

  // A blocking allowance refuses before anything is written (`AllowanceExceeded`).
  run blockRefusalTest =
    init
      .then(subscribe)
      .then(trackUsage("messages", MESSAGES_INCLUDED))
      .expect(state.remaining.get("messages") == 0)
      .expect(state.used.get("messages") == MESSAGES_INCLUDED)
      .then(trackUsage("messages", 1).fail())

  // A `bill` allowance never refuses on quantity, and its remaining goes
  // negative to say the period billed past what it included (ADR 0009).
  run billPastIncludedTest =
    init
      .then(subscribe)
      .then(trackUsage("requests", REQUESTS_INCLUDED + 2))
      .expect(state.remaining.get("requests") == -2)
      .expect(state.used.get("requests") == REQUESTS_INCLUDED + 2)
      .expect(paykitInvariant)

  // ── the shared pool ────────────────────────────────────────────────────────

  run creditSpendTest =
    init
      .then(subscribe)
      .then(trackUsage("compute", 2))
      .expect(state.credits == CREDITS_GRANTED - 2 * COMPUTE_RATE)
      .expect(state.used.get("compute") == 2 * COMPUTE_RATE)
      .expect(paykitInvariant)

  // The pool cannot cover what the usage costs (`CreditExceeded`): 7 units at
  // rate 3 is 21 credits against a grant of 20.
  run creditRefusalTest =
    init
      .then(subscribe)
      .expect(state.credits == CREDITS_GRANTED)
      .then(trackUsage("compute", 7).fail())

  run consumeCreditsTest =
    init
      .then(subscribe)
      .then(consumeCredits(8))
      .expect(state.credits == CREDITS_GRANTED - 8)
      .expect(state.consumed == 8)
      .expect(paykitInvariant)

  // What open holds reserved is not spendable through `ConsumeCredits`
  // (`CreditExceedsBalance`), so settle still has credits to bill.
  run consumeKeepsReservationTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "compute", 4))
      .expect(state.credits == CREDITS_GRANTED)
      .then(consumeCredits(9).fail())

  // ── holds ──────────────────────────────────────────────────────────────────

  // A settle returns whatever the work did not bill, in the same command.
  run settleReturnsTheRestTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "messages", 5))
      .then(settleHold("hold-a", 2))
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED - 2)
      .expect(state.used.get("messages") == 2)
      .expect(state.holds.get("hold-a").status == Settled)
      .expect(paykitInvariant)

  // Settling for nothing is a release: the hold billed no units.
  run settleNothingBillsNothingTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "messages", 5))
      .then(settleHold("hold-a", 0))
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED)
      .expect(state.used.get("messages") == 0)

  // A credit-priced hold bills at the rate it captured, not the catalogue's.
  run settleCreditHoldTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "compute", 4))
      .then(settleHold("hold-a", 1))
      .expect(state.credits == CREDITS_GRANTED - COMPUTE_RATE)
      .expect(state.used.get("compute") == COMPUTE_RATE)
      .expect(paykitInvariant)

  // A hold id is a replay key: the same id held twice records nothing the
  // second time.
  run holdReplayTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "messages", 1))
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED - 1)
      .then(hold("hold-a", "messages", 1).fail())

  // An open hold keeps its units out of a second hold's reach.
  run holdRefusesPastRemainingTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "messages", 6))
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED - 6)
      .then(hold("hold-b", "messages", 5).fail())

  run holdFitsRemainingTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "messages", 6))
      .then(hold("hold-b", "messages", 4))
      .expect(state.remaining.get("messages") == 0)
      .expect(paykitInvariant)

  // At the deadline the sweep owns the hold: the settle is refused
  // (`HoldExpired`) ...
  run settlePastDeadlineTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "messages", 5))
      .then(4.reps(_ => tick))
      .expect(state.now == HOLD_TTL)
      .then(settleHold("hold-a", 5).fail())

  // ... and the expiry returns every unit, because an expiry is not a charge.
  run holdExpiryTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "messages", 5))
      .then(4.reps(_ => tick))
      .then(expireHold("hold-a"))
      .expect(state.holds.get("hold-a").status == ExpiredHold)
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED)
      .expect(paykitInvariant)

  // ── the standing ───────────────────────────────────────────────────────────

  // Grace still spends; recovering hands the standing back.
  run graceAllowsUsageTest =
    init
      .then(subscribe)
      .then(enterGrace)
      .then(trackUsage("messages", 1))
      .then(recover)
      .expect(state.status == Active)
      .expect(state.used.get("messages") == 1)
      .expect(paykitInvariant)

  // A terminal standing spends nothing (`StandingBlocksUsage`) ...
  run cancelRefusesSpendTest =
    init
      .then(subscribe)
      .then(cancelStanding)
      .expect(state.status == Canceled)
      .then(trackUsage("messages", 1).fail())

  // ... and refuses to settle a hold that is still open (`StandingEnded`) ...
  run cancelRefusesSettleTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "compute", 2))
      .then(cancelStanding)
      .then(settleHold("hold-a", 1).fail())

  // ... but the hold is still closable: a release is a cleanup, not a spend
  // (ADR 0021).
  run cancelKeepsHoldReleasableTest =
    init
      .then(subscribe)
      .then(hold("hold-a", "compute", 2))
      .then(cancelStanding)
      .then(releaseHold("hold-a"))
      .expect(state.status == Canceled)
      .expect(state.holds.get("hold-a").status == Released)
      .expect(state.credits == CREDITS_GRANTED)
      .expect(paykitInvariant)

  // ── the period boundary ────────────────────────────────────────────────────

  // A close rolls the period: the next boundary is one period out, and a period
  // that spent nothing carries as much as the cap allows.
  run closeRollsThePeriodTest =
    init
      .then(subscribe)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.periodEnd == 2 * PERIOD_LENGTH)
      .expect(state.carried.get("messages") == MESSAGES_CARRIED_CAP)
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED + MESSAGES_CARRIED_CAP)
      .expect(state.used.get("messages") == 0)
      .expect(paykitInvariant)

  // What the period did not spend rolls over — the remainder, not the cap: 5
  // units used leaves 5, so the next period starts at 15.
  run closeCarriesTheRemainderTest =
    init
      .then(subscribe)
      .then(trackUsage("messages", 5))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.carried.get("messages") == 5)
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED + 5)
      .expect(state.used.get("messages") == 0)
      .expect(paykitInvariant)

  // An overdrawn `bill` allowance carries nothing, and the debt does not follow
  // it into the next period.
  run closeDropsAnOverdrawnBillTest =
    init
      .then(subscribe)
      .then(trackUsage("requests", REQUESTS_INCLUDED + 10))
      .expect(state.remaining.get("requests") == -10)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.remaining.get("requests") == REQUESTS_INCLUDED)
      .expect(state.carried.get("requests") == 0)
      .expect(state.used.get("requests") == 0)
      .expect(paykitInvariant)

  // `resets: "never"` is a lifetime count for the tier it was recorded on: the
  // boundary leaves the counter and its remainder exactly where they were.
  run closeKeepsANeverCounterTest =
    init
      .then(subscribe)
      .then(trackUsage("storage", 3))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.remaining.get("storage") == STORAGE_INCLUDED - 3)
      .expect(state.used.get("storage") == 3)
      .expect(state.carried.get("storage") == 0)
      .expect(paykitInvariant)

  // The plan's own credits end with the period they were sold for.
  run closeExpiresThePlanCreditsTest =
    init
      .then(subscribe)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.credits == 0)
      .expect(state.expired == CREDITS_GRANTED)
      .expect(paykitInvariant)

  // A hold whose deadline is past the boundary is dropped by the boundary, and
  // its units are not carried: the period promised them.
  run closeDropsAHoldPastTheBoundaryTest =
    init
      .then(subscribe)
      .then(3.reps(_ => tick))
      .then(hold("hold-a", "messages", 4))
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED - 4)
      .then(2.reps(_ => tick))
      .then(closePeriod)
      .expect(state.holds.get("hold-a").status == Available)
      .expect(state.remaining.get("messages") == MESSAGES_INCLUDED + MESSAGES_CARRIED_CAP)
      .expect(paykitInvariant)

  // A hold on a feature the boundary does not reset survives it, still
  // reserving what it took.
  run closeKeepsAHoldItDoesNotResetTest =
    init
      .then(subscribe)
      .then(3.reps(_ => tick))
      .then(hold("hold-a", "storage", 2))
      .then(2.reps(_ => tick))
      .then(closePeriod)
      .expect(state.holds.get("hold-a").status == Open)
      .expect(state.remaining.get("storage") == STORAGE_INCLUDED - 2)
      .expect(paykitInvariant)

  // A close before the boundary records nothing (`PeriodNotClosed`).
  run closeBeforeTheBoundaryTest =
    init
      .then(subscribe)
      .then(3.reps(_ => tick))
      .expect(state.now == 3)
      .then(closePeriod.fail())

  // A terminal standing opens no further periods (`PeriodNotClosed`).
  run closeAfterCancellationTest =
    init
      .then(subscribe)
      .then(cancelStanding)
      .then(5.reps(_ => tick))
      .expect(state.now == PERIOD_LENGTH)
      .then(closePeriod.fail())
}
