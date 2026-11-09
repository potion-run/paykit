// Named scenarios for `standing.qnt`. Each run is a claim about the accept-set
// and the state a move leaves: the paths that must exist, and the moves that
// must be refused. `quint test` fails a scenario whose action cannot fire, so an
// action cannot go dead while the invariants stay green.
//
// Run: `quint test specs/paykit/standing_test.qnt --main=standing_test`
module standing_test {

  import standing.* from "./standing"

  // ── activation ─────────────────────────────────────────────────────────────

  run subscribeTest =
    init
      .then(subscribe(Pro))
      .expect(state.phase == Active and state.planCredits == grantOf(Pro))
      .expect(standingInvariant)

  // A second activation on an open standing is already subscribed: the action
  // is disabled, not a second grant.
  run subscribeTwiceTest =
    init
      .then(subscribe(Pro))
      .then(subscribe(Pro).fail())

  run startTrialTest =
    init
      .then(startTrial(Pro))
      .expect(state.phase == Trialing and state.trialUsed)
      .expect(state.planCredits == grantOf(Pro))
      .expect(standingInvariant)

  // The trial latch is lifetime: a second trial is refused whatever the phase.
  run trialIsOnceTest =
    init
      .then(startTrial(Free))
      .then(startTrial(Pro).fail())

  // `StartTrial` is the one deliberate replacement for an open standing (ADR
  // 0020): a subscriber that never trialed can begin one.
  run trialReplacesAnOpenStandingTest =
    init
      .then(subscribe(Pro))
      .then(startTrial(Free))
      .expect(state.phase == Trialing and state.tier == Free)
      .expect(standingInvariant)

  // ── trials ─────────────────────────────────────────────────────────────────

  run extendTrialTest =
    init
      .then(startTrial(Pro))
      .then(extendTrial(12))
      .expect(state.periodEnd == 12)
      .expect(standingInvariant)

  // An extension that does not move the deadline forward is refused.
  run trialNeverMovesBackTest =
    init
      .then(startTrial(Pro))
      .then(extendTrial(3).fail())

  // ── grace, dunning and expiry ──────────────────────────────────────────────

  run enterGraceTest =
    init
      .then(subscribe(Pro))
      .then(enterGrace(8))
      .expect(state.phase == Grace and state.graceEnd == 8)
      .expect(standingInvariant)

  run enterGraceFromActiveOnlyTest =
    init
      .then(startTrial(Pro))
      .then(enterGrace(8))
      .expect(state.phase == Grace)

  run recordPaymentRecoversTest =
    init
      .then(subscribe(Pro))
      .then(enterGrace(8))
      .then(recordPayment)
      .expect(state.phase == Active and state.graceEnd == NO_DEADLINE)
      .expect(standingInvariant)

  run recoverTest =
    init
      .then(subscribe(Pro))
      .then(enterGrace(8))
      .then(recover)
      .expect(state.phase == Active)
      .expect(standingInvariant)

  // A failure opens a run and counts the attempt; a second failure stays in
  // the same run and keeps counting.
  run dunningRunTest =
    init
      .then(subscribe(Pro))
      .then(failPayment(8))
      .then(failPayment(10))
      .expect(state.phase == Grace)
      .expect(state.dunningRun == 1 and state.dunningAttempts == 2)
      .expect(standingInvariant)

  // A payment ends the run, so the next failure is a new one.
  run newRunAfterPaymentTest =
    init
      .then(subscribe(Pro))
      .then(failPayment(8))
      .then(recordPayment)
      .then(failPayment(9))
      .expect(state.dunningAttempts == 1)
      .expect(standingInvariant)

  // A rung records only for the run and attempt it was scheduled for.
  run dunningRungTest =
    init
      .then(subscribe(Pro))
      .then(failPayment(8))
      .then(dunningRung(1, 1))
      .expect(state.dunningRungs == 1)
      .expect(standingInvariant)

  // A rung from a run that a payment ended is stale.
  run staleDunningRungTest =
    init
      .then(subscribe(Pro))
      .then(failPayment(8))
      .then(recordPayment)
      .then(failPayment(9))
      .expect(state.dunningRun == 2)
      .then(dunningRung(1, 1).fail())

  // A fire before the deadline records nothing (a disabled action).
  run graceEarlyFireTest =
    init
      .then(subscribe(Pro))
      .then(enterGrace(3))
      .then(graceElapsed.fail())

  // The deadline is the hard stop: the clock stops at it and the expiry lands.
  run graceDeadlineTest =
    init
      .then(subscribe(Pro))
      .then(enterGrace(3))
      .then(3.reps(_ => tick))
      .expect(state.now == 3)
      .then(graceElapsed)
      .expect(state.phase == Expired)
      .expect(standingInvariant)

  // Grace is a forward window. A deadline at or before now is disabled, not a
  // window that opens already lapsed.
  run enterGracePastDeadlineTest =
    init
      .then(subscribe(Pro))
      .then(enterGrace(0).fail())

  run failPaymentPastDeadlineTest =
    init
      .then(subscribe(Pro))
      .then(failPayment(0).fail())

  // Expiry is only from grace; an active standing has no grace to expire.
  run expireOnlyFromGraceTest =
    init
      .then(subscribe(Pro))
      .then(expire.fail())

  // ── cancellation ───────────────────────────────────────────────────────────

  run cancellationAtBoundaryTest =
    init
      .then(subscribe(Pro))
      .then(scheduleCancellation)
      .expect(state.cancelAtPeriodEnd)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.phase == Canceled)
      .expect(state.periodEnd == 2 * PERIOD_LENGTH)
      .expect(standingInvariant)

  run resumeTest =
    init
      .then(subscribe(Pro))
      .then(scheduleCancellation)
      .then(resume)
      .expect(not(state.cancelAtPeriodEnd))
      .expect(standingInvariant)

  // A close with a cancellation scheduled keeps the flag on the terminal
  // standing; `resume` is the operator move that clears it (ADR 0020).
  run resumeAfterCanceledTest =
    init
      .then(subscribe(Pro))
      .then(scheduleCancellation)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .then(resume)
      .expect(state.phase == Canceled and not(state.cancelAtPeriodEnd))

  // A terminal standing has no future: the pending change is dropped by the
  // expiry, and no later close will read it.
  run expiryClearsPendingTest =
    init
      .then(subscribe(Free))
      .then(scheduleTier(Pro))
      .expect(isPending(state.pending))
      .then(enterGrace(8))
      .then(expire)
      .expect(state.phase == Expired)
      .expect(not(isPending(state.pending)))
      .expect(standingInvariant)

  // A cancellation wins the boundary: the pending change is withdrawn, the
  // tier stays the one the account was on, and the plan pool is expired.
  run cancellationWinsTheBoundaryTest =
    init
      .then(subscribe(Free))
      .then(scheduleTier(Pro))
      .then(scheduleCancellation)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.phase == Canceled)
      .expect(state.tier == Free)
      .expect(not(isPending(state.pending)))
      .expect(state.planCredits == 0)
      .expect(standingInvariant)

  // ── the period boundary ────────────────────────────────────────────────────

  run trialConvertsAtCloseTest =
    init
      .then(startTrial(Pro))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.phase == Active)
      .expect(state.periodEnd == 2 * PERIOD_LENGTH)
      .expect(standingInvariant)

  // A scheduled change is applied before the period rolls: the standing is on
  // the new tier, the schedule is empty, and the new grant is in the pool.
  run scheduledTierLandsAtCloseTest =
    init
      .then(subscribe(Free))
      .then(scheduleTier(Pro))
      .expect(isPending(state.pending))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.tier == Pro and not(isPending(state.pending)))
      .expect(state.planCredits == grantOf(Pro))
      .expect(standingInvariant)

  run withdrawTierTest =
    init
      .then(subscribe(Free))
      .then(scheduleTier(Pro))
      .then(withdrawTier)
      .expect(not(isPending(state.pending)))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.tier == Free)

  // A mid-period change replaces the schedule immediately and starts the
  // refill budget over; it does not re-grant the pool.
  run changeTierTest =
    init
      .then(subscribe(Free))
      .then(scheduleTier(Scale))
      .then(failTopUp)
      .expect(state.topUpAttempts == 1)
      .then(changeTier(Pro))
      .expect(state.tier == Pro and not(isPending(state.pending)))
      .expect(state.topUpAttempts == 0)
      .expect(state.planCredits == grantOf(Free))
      .expect(standingInvariant)

  // ── a "never" pool at a boundary ───────────────────────────────────────────

  // A lifetime grant survives a close. The plan pool is expired and recorded;
  // the lifetime source is untouched.
  run lifetimeCreditsSurviveCloseTest =
    init
      .then(subscribe(Pro))
      .then(buyTopUp)
      .expect(state.planCredits == grantOf(Pro) and state.lifetimeCredits == TOP_UP_PACK)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.planCredits == 0)
      .expect(state.lifetimeCredits == TOP_UP_PACK)
      .expect(state.planExpired == grantOf(Pro))
      .expect(standingInvariant)

  // A scheduled change replaces the plan source and leaves the lifetime source
  // alone. The old plan pool is expired even though the new plan lands.
  run lifetimeCreditsSurvivePendingChangeTest =
    init
      .then(subscribe(Pro))
      .then(buyTopUp)
      .then(scheduleTier(Scale))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.planCredits == grantOf(Scale))
      .expect(state.lifetimeCredits == TOP_UP_PACK)
      .expect(state.planExpired == grantOf(Pro))
      .expect(standingInvariant)

  // A period pool is expired by a close, and the fold records it.
  run periodCreditsExpireTest =
    init
      .then(subscribe(Pro))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.planCredits == 0)
      .expect(state.planExpired == grantOf(Pro))
      .expect(standingInvariant)

  // ── auto top-up budget ─────────────────────────────────────────────────────

  run topUpEpisodeTest =
    init
      .then(subscribe(Pro))
      .then(failTopUp)
      .expect(state.topUpAttempts == 1 and state.topUpEpisode == 1)
      .then(buyTopUp)
      .expect(state.topUpAttempts == 0)
      .then(failTopUp)
      .expect(state.topUpAttempts == 1 and state.topUpEpisode == 2)
      .expect(standingInvariant)

  // An old episode's rung is stale even when the new episode has the same
  // attempt number: the episode identity, not the count, owns the rung.
  run staleTopUpRungTest =
    init
      .then(subscribe(Pro))
      .then(failTopUp)
      .then(buyTopUp)
      .then(failTopUp)
      .expect(state.topUpEpisode == 2)
      .then(topUpRung(1, 1).fail())

  run currentTopUpRungTest =
    init
      .then(subscribe(Pro))
      .then(failTopUp)
      .then(buyTopUp)
      .then(spendCredits(27))
      .then(failTopUp)
      .expect(state.topUpEpisode == 2 and state.planCredits + state.lifetimeCredits <= TOP_UP_THRESHOLD)
      .then(topUpRung(2, 1))
      .expect(state.topUpRungs == 1)
      .expect(standingInvariant)

  // A rung is only live while the pool is still under the line.
  run topUpRungOnlyWhenLowTest =
    init
      .then(subscribe(Pro))
      .then(failTopUp)
      .expect(state.planCredits + state.lifetimeCredits > TOP_UP_THRESHOLD)
      .then(topUpRung(1, 1).fail())

  // ── the clock ──────────────────────────────────────────────────────────────

  // The clock stops at the period boundary instead of passing it.
  run clockStopsAtBoundaryTest =
    init
      .then(subscribe(Pro))
      .then(5.reps(_ => tick))
      .expect(state.now == PERIOD_LENGTH)
      .then(tick.fail())

  run closeAfterBoundaryTest =
    init
      .then(subscribe(Pro))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.periodEnd == 2 * PERIOD_LENGTH)
      .expect(standingInvariant)
}
