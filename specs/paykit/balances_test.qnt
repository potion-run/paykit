// The named scenarios for the balance ledger. Each run is a path the code must
// be able to take, and each expectation is one line of the ADR the code follows.
module balances_test {
  import balances.* from "./balances"

  // The plan source is spent before a grant. Two units leave the plan, and the
  // lifetime grant is untouched.
  run spendPlanBeforeGrantTest =
    init
      .then(createGrant(true))
      .then(spend(2))
      .expect(state.plan == 2)
      .expect(state.lifetime == 3)
      .expect(not(state.lastSpendUsedGrant))
      .expect(balancesInvariant)

  // A spend larger than the plan reaches the grant, and only after the plan is
  // empty. Five units: four from the plan, one from the lifetime grant.
  run spendReachesGrantTest =
    init
      .then(createGrant(true))
      .then(spend(5))
      .expect(state.plan == 0)
      .expect(state.lifetime == 2)
      .expect(state.lastSpendUsedGrant)
      .expect(state.lastSpendPlan == 0)
      .expect(lifetimeConserved)
      .expect(balancesInvariant)

  // A plan change replaces the plan source and leaves the lifetime grant alone.
  run grantSurvivesPlanChangeTest =
    init
      .then(createGrant(true))
      .then(spend(5))
      .then(changePlan)
      .expect(state.plan == 4)
      .expect(state.lifetime == 2)
      .expect(lifetimeConserved)
      .expect(balancesInvariant)

  // A boundary carries at most the cap, and the rollover never grows past it.
  run closeRollsOverCapTest =
    init
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.plan == 4)
      .expect(state.rollover == 2)
      .expect(state.maxCarried == 2)
      .expect(balancesInvariant)

  run rolloverDoesNotAccumulatePastCapTest =
    init
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.rollover == 2)
      .expect(balancesInvariant)

  // The expiring grant's deadline removes it; the units are recorded as
  // expired, not dropped.
  run expiringGrantDiesTest =
    init
      .then(createGrant(false))
      .then(3.reps(_ => tick))
      .then(expireGrant)
      .expect(state.expiring == 0)
      .expect(state.expired)
      .expect(state.expiringExpired == 3)
      .expect(expiringConserved)
      .expect(balancesInvariant)

  // The same deadline leaves a lifetime grant exactly where it was.
  run lifetimeGrantSurvivesExpiryTest =
    init
      .then(createGrant(false))
      .then(createGrant(true))
      .then(3.reps(_ => tick))
      .then(expireGrant)
      .expect(state.expiring == 0)
      .expect(state.lifetime == 3)
      .expect(lifetimeConserved)
      .expect(balancesInvariant)

  // The whole order in one path: plan, then rollover, then the grant.
  run spendPlanThenRolloverThenGrantTest =
    init
      .then(createGrant(true))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.rollover == 2)
      .then(spend(6))
      .expect(state.plan == 0)
      .expect(state.rollover == 0)
      .expect(state.lifetime == 3)
      .expect(not(state.lastSpendUsedGrant))
      .then(spend(1))
      .expect(state.lifetime == 2)
      .expect(state.lastSpendUsedGrant)
      .expect(balancesInvariant)

  // A spend beyond every source is disabled, not silently clamped.
  run spendBeyondTotalFailsTest =
    init
      .then(createGrant(true))
      .then(spend(100).fail())

  // A close before the boundary is disabled.
  run closeBeforeBoundaryFailsTest =
    init
      .then(closePeriod.fail())

  // A lifetime grant survives a close with its units intact.
  run lifetimeSurvivesCloseTest =
    init
      .then(createGrant(true))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.lifetime == 3)
      .expect(lifetimeConserved)
      .expect(balancesInvariant)
}
