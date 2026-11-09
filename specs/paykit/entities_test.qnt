// The named scenarios for the entity protocol. Each run is a path the code must
// be able to take, and each expectation is one line of ADR 0040.
module entities_test {
  import entities.* from "./entities"

  // An entity carries its own plan source. Attaching the item and spending from
  // it leaves the parent's plan alone.
  run entityHasItsOwnPlanTest =
    init
      .then(attachEntity(EntityA))
      .then(attachPlan(EntityA, false))
      .expect(state.plan.get(EntityA) == 4)
      .then(spend(EntityA, 2))
      .expect(state.plan.get(EntityA) == 2)
      .expect(state.plan.get(Parent) == 0)
      .expect(scopedConservation)
      .expect(entitiesInvariant)

  // One pooled grant is shared: the first entity's spend lowers what the second
  // one reports and can spend.
  run pooledGrantDrawnByTwoEntitiesTest =
    init
      .then(attachEntity(EntityA))
      .then(attachEntity(EntityB))
      .then(attachPlan(Parent, true))
      .expect(state.pooled == 6)
      .then(spend(EntityA, 2))
      .expect(state.pooled == 4)
      .expect(state.poolView.get(EntityA) == 4)
      .expect(state.poolView.get(EntityB) == 4)
      .then(spend(EntityB, 3))
      .expect(state.pooled == 1)
      .expect(state.poolView.get(EntityA) == 1)
      .expect(state.poolView.get(EntityB) == 1)
      .expect(pooledGrantShared)
      .expect(entitiesInvariant)

  // A transfer moves units between two scopes of the same customer, and the
  // customer's total does not change.
  run transferConservesTheTotalTest =
    init
      .then(attachEntity(EntityA))
      .then(attachEntity(EntityB))
      .then(attachPlan(EntityA, false))
      .then(transfer(EntityA, EntityB, 3))
      .expect(state.plan.get(EntityA) == 1)
      .expect(state.plan.get(EntityB) == 3)
      .expect(state.transferCount == 1)
      .expect(totalConservedAcrossScopes)
      .expect(scopedConservation)
      .expect(transferStaysInsideOneCustomer)
      .expect(entitiesInvariant)

  // A transfer over the source's own balance is disabled; it does not borrow
  // from the pooled source or from the sibling.
  run transferBeyondSourceFailsTest =
    init
      .then(attachEntity(EntityA))
      .then(attachEntity(EntityB))
      .then(attachPlan(EntityA, false))
      .then(transfer(EntityA, EntityB, 5).fail())

  // A transfer never addresses another customer's scope.
  run transferAcrossCustomersFailsTest =
    init
      .then(attachEntity(EntityA))
      .then(attachPlan(EntityA, false))
      .then(transfer(EntityA, Foreign, 1).fail())

  // The shared pool belongs to the parent; a transfer writes own sources only,
  // so it cannot take pooled units out to one entity.
  run transferOutOfThePoolFailsTest =
    init
      .then(attachEntity(EntityA))
      .then(attachPlan(Parent, true))
      .then(transfer(Parent, EntityA, 1).fail())

  // An archived entity holds nothing: its plan and grant were swept to the
  // parent, and it cannot spend even while the shared pool has units.
  run archivedEntityCannotSpendTest =
    init
      .then(attachEntity(EntityA))
      .then(attachPlan(EntityA, false))
      .then(attachPlan(Parent, true))
      .then(archiveEntity(EntityA))
      .expect(state.plan.get(EntityA) == 0)
      .expect(state.grant.get(EntityA) == 0)
      .expect(state.plan.get(Parent) == 4)
      .expect(state.poolView.get(EntityA) == 0)
      .expect(archivedEntityHoldsNothing)
      .expect(entitiesInvariant)
      .then(spend(EntityA, 1).fail())

  // A transfer preserves the class it moves: lifetime units stay lifetime on
  // the target, so a transfer never extends a grant by turning it into a plan.
  run transferKeepsLifetimeUnitsLifetimeTest =
    init
      .then(attachEntity(EntityA))
      .then(attachEntity(EntityB))
      .then(grant(EntityA))
      .then(transfer(EntityA, EntityB, 2))
      .expect(state.grant.get(EntityA) == 1)
      .expect(state.grant.get(EntityB) == 2)
      .expect(state.plan.get(EntityB) == 0)
      .expect(state.grantIssued.get(EntityB) == 2)
      .expect(lifetimeConserved)
      .expect(entitiesInvariant)

  // A close replaces the plan source and expires what it did not use. The
  // lifetime grant is untouched.
  run closeLeavesLifetimeSourcesTest =
    init
      .then(attachEntity(EntityA))
      .then(grant(EntityA))
      .then(attachPlan(EntityA, false))
      .then(spend(EntityA, 1))
      .then(5.reps(_ => tick))
      .then(closePeriod)
      .expect(state.plan.get(EntityA) == 4)
      .expect(state.expired.get(EntityA) == 3)
      .expect(state.grant.get(EntityA) == 3)
      .expect(state.grantIssued.get(EntityA) == 3)
      .expect(lifetimeConserved)
      .expect(scopedConservation)
      .expect(entitiesInvariant)

  // A scope spends its own plan before the shared pool, and reaches the pool
  // only when its own sources are empty.
  run ownSourcesSpentBeforeThePoolTest =
    init
      .then(attachEntity(EntityA))
      .then(attachPlan(EntityA, false))
      .then(attachPlan(Parent, true))
      .then(spend(EntityA, 3))
      .expect(state.plan.get(EntityA) == 1)
      .expect(state.pooled == 6)
      .then(spend(EntityA, 2))
      .expect(state.plan.get(EntityA) == 0)
      .expect(state.pooled == 5)
      .expect(state.lastSpendUsedPool)
      .expect(state.lastSpendOwnAfter == 0)
      .expect(spendOnlyFromOwnOrPooled)
      .expect(entitiesInvariant)

  // A close before the boundary is disabled.
  run closeBeforeBoundaryFailsTest =
    init
      .then(closePeriod.fail())

  // An entity cannot be archived before it is attached.
  run archiveBeforeAttachFailsTest =
    init
      .then(archiveEntity(EntityA).fail())

  // An entity cannot be attached twice.
  run attachTwiceFailsTest =
    init
      .then(attachEntity(EntityA))
      .then(attachEntity(EntityA).fail())

  // Archiving is terminal: an archived entity is not attached again.
  run archiveIsTerminalTest =
    init
      .then(attachEntity(EntityA))
      .then(archiveEntity(EntityA))
      .then(attachEntity(EntityA).fail())
}
