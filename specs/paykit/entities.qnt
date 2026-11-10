// A Quint model of the entity protocol: one customer with a parent scope and
// two child entities, one pooled plan item and one entity-owned balance, and a
// transfer that moves units between two scopes of that customer.
//
// This is the seventh protocol. `balances.qnt` models the sources behind one
// count; this model keeps that abstraction and adds the scope each source
// belongs to. An entity is not a customer: the customer owns one aggregate, and
// every scope's state is a partition of it, so a transfer is one command, one
// transaction and one event.
//
// Source correspondence:
//   attachEntity      ↔ the entity create operation (planned)
//   archiveEntity     ↔ the entity archive operation (planned)
//   attachPlan        ↔ Subscribe.command.ts, and the entity branch of attach
//   grant             ↔ GrantBalance.command.ts
//   spend             ↔ TrackUsage.command.ts
//   setCap, clearCap  ↔ SetBillingControls.command.ts
//   transfer          ↔ Transfer (planned, ADR 0040)
//   closePeriod       ↔ ClosePeriod.command.ts
//   tick              ↔ the platform clock
//
// The plan class here is the plan and rollover of `balances.qnt` collapsed into
// one source; expiry is the close. The two classes that matter are the
// per-period plan and the lifetime grant, because a transfer must preserve the
// class it moves. Scope and the code divergences are in README.md beside this
// file.
module entities {

  // ── types ──────────────────────────────────────────────────────────────────

  // The scopes of one customer, plus a scope of a second customer. `Foreign`
  // exists so a cross-customer transfer is a representable, refusable move
  // rather than a type error; it never belongs to this customer's aggregate.
  type Scope = Parent | EntityA | EntityB | Foreign

  // A scope is attached, has never been attached, or was archived. Archiving is
  // terminal: a new entity is a new id, never a reopened one.
  type Status = Detached | Attached | Archived

  // The transfer history, so `transferStaysInsideOneCustomer` can look at every
  // move that was recorded rather than at the current balances alone.
  type Transfer = {
    from: Scope,
    target: Scope,
    amount: int,
  }

  type State = {
    now: int,
    periodEnd: int,
    status: Scope -> Status,
    // An entity-owned plan source and a lifetime grant, per scope. The plan is
    // replaced at the close; the grant is not.
    plan: Scope -> int,
    grant: Scope -> int,
    // History, so conservation is a fold over the log rather than an assertion
    // on the current numbers.
    spentPlan: Scope -> int,
    spentGrant: Scope -> int,
    expired: Scope -> int,
    planIssued: Scope -> int,
    grantIssued: Scope -> int,
    // The pooled source is one number owned by the parent. `poolView` is the
    // per-scope report of it, the row `Balance.breakdown` shows every entity.
    pooled: int,
    pooledGranted: int,
    pooledSpent: int,
    pooledExpired: int,
    poolView: Scope -> int,
    poolDrawn: Scope -> int,
    // The customer's money ceiling for this feature. `hasCap` is separate
    // because a ceiling of zero is a real control, not the absence of one.
    hasCap: bool,
    cap: int,
    // What this period has billed. One request is one charge, so a split draw
    // bills once.
    billed: int,
    // Whether `setCap` put the ceiling under money already billed. A ceiling
    // stops new spend; it never unbills history.
    capLoweredBelowBill: bool,
    // The last spend's order: whether it reached the pool, and what of its own
    // sources was left when it did.
    lastSpendUsedPool: bool,
    lastSpendOwnAfter: int,
    // What had left a scope when it was archived. `noSpendAfterArchive` compares
    // this with the same fold afterwards.
    spentAtArchive: Scope -> int,
    plans: Set[Scope],
    transfers: Set[Transfer],
    attaches: int,
    archives: int,
    planAttaches: int,
    grants: int,
    spends: int,
    transferCount: int,
    closes: int,
  }

  // ── the catalogue and the clock ────────────────────────────────────────────

  // This customer's scopes. `Foreign` is deliberately not in it.
  pure val SCOPES: Set[Scope] = Set(Parent, EntityA, EntityB)

  pure val ALL_SCOPES: Set[Scope] = Set(Parent, EntityA, EntityB, Foreign)

  pure val ENTITIES: Set[Scope] = Set(EntityA, EntityB)

  pure val PERIOD_LENGTH: int = 5
  pure val PLAN_GRANT: int = 4
  pure val POOLED_GRANT: int = 6
  pure val GRANT_SIZE: int = 3
  pure val FOREIGN_BALANCE: int = 5
  pure val PRICE: int = 2

  pure def chargeOf(units: int): int = units * PRICE

  pure def owns(scope: Scope): bool = scope != Foreign

  pure def attached(s: State, scope: Scope): bool = s.status.get(scope) == Attached

  pure def ownOf(s: State, scope: Scope): int = s.plan.get(scope) + s.grant.get(scope)

  pure def spentOf(s: State, scope: Scope): int =
    s.spentPlan.get(scope) + s.spentGrant.get(scope)

  pure def drawnOf(s: State, scope: Scope): int = spentOf(s, scope) + s.poolDrawn.get(scope)

  pure def attachedScopes(s: State): Set[Scope] = SCOPES.filter(scope => attached(s, scope))

  // ── the shared source ──────────────────────────────────────────────────────

  // One pool, one number, and one report per attached scope. Writing the pool
  // only through this helper is what makes `pooledGrantShared` a check: a scope
  // that kept its own copy would be a second pool.
  pure def reportPool(s: State, poolAfter: int): State = {
    ...s,
    pooled: poolAfter,
    poolView: SCOPES.fold(s.poolView, (acc, scope) =>
      if (attached(s, scope)) acc.set(scope, poolAfter) else acc.set(scope, 0)),
  }

  // ── the moves ──────────────────────────────────────────────────────────────

  pure def applyAttachEntity(s: State, scope: Scope): State = {
    ...s,
    status: s.status.set(scope, Attached),
    poolView: s.poolView.set(scope, s.pooled),
    attaches: s.attaches + 1,
  }

  // Archiving returns the entity's unspent own sources to the parent in the same
  // move, so an archived entity holds nothing and nothing is destroyed. The
  // sweep is recorded as units that left the scope, which is what keeps the
  // per-scope fold and the lifetime fold intact.
  pure def applyArchive(s: State, scope: Scope): State = {
    val movedPlan = s.plan.get(scope)
    val movedGrant = s.grant.get(scope)
    {
      ...s,
      status: s.status.set(scope, Archived),
      plan: s.plan.set(scope, 0).set(Parent, s.plan.get(Parent) + movedPlan),
      grant: s.grant.set(scope, 0).set(Parent, s.grant.get(Parent) + movedGrant),
      spentPlan: if (movedPlan > 0) s.spentPlan.set(scope, s.spentPlan.get(scope) + movedPlan) else s.spentPlan,
      spentGrant: if (movedGrant > 0) s.spentGrant.set(scope, s.spentGrant.get(scope) + movedGrant) else s.spentGrant,
      planIssued: if (movedPlan > 0) s.planIssued.set(Parent, s.planIssued.get(Parent) + movedPlan) else s.planIssued,
      grantIssued: if (movedGrant > 0) s.grantIssued.set(Parent, s.grantIssued.get(Parent) + movedGrant) else s.grantIssued,
      poolView: s.poolView.set(scope, 0),
      spentAtArchive: s.spentAtArchive.set(scope, drawnOf(s, scope) + movedPlan + movedGrant),
      archives: s.archives + 1,
    }
  }

  // A plan item is entity-scoped unless it is pooled. A pooled item belongs to
  // the parent and every attached entity draws on the same grant.
  pure def applyAttachPlan(s: State, scope: Scope, pooled: bool): State =
    if (pooled)
      reportPool(
        {
          ...s,
          pooledGranted: s.pooledGranted + POOLED_GRANT,
          planAttaches: s.planAttaches + 1,
        },
        s.pooled + POOLED_GRANT,
      )
    else {
      ...s,
      plan: s.plan.set(scope, s.plan.get(scope) + PLAN_GRANT),
      planIssued: s.planIssued.set(scope, s.planIssued.get(scope) + PLAN_GRANT),
      plans: s.plans.union(Set(scope)),
      planAttaches: s.planAttaches + 1,
    }

  pure def applyGrant(s: State, scope: Scope): State = {
    ...s,
    grant: s.grant.set(scope, s.grant.get(scope) + GRANT_SIZE),
    grantIssued: s.grantIssued.set(scope, s.grantIssued.get(scope) + GRANT_SIZE),
    grants: s.grants + 1,
  }

  // The order is own plan, own lifetime grant, then the shared pool: a scope
  // spends what it owns before it draws on the parent's grant.
  pure def applySpend(s: State, scope: Scope, amount: int): State = {
    val fromPlan = if (amount <= s.plan.get(scope)) amount else s.plan.get(scope)
    val afterPlan = amount - fromPlan
    val fromGrant = if (afterPlan <= s.grant.get(scope)) afterPlan else s.grant.get(scope)
    val afterOwn = afterPlan - fromGrant
    val fromPool = afterOwn
    val ownAfter = ownOf(s, scope) - fromPlan - fromGrant
    val spent = {
      ...s,
      plan: s.plan.set(scope, s.plan.get(scope) - fromPlan),
      grant: s.grant.set(scope, s.grant.get(scope) - fromGrant),
      spentPlan: if (fromPlan > 0) s.spentPlan.set(scope, s.spentPlan.get(scope) + fromPlan) else s.spentPlan,
      spentGrant: if (fromGrant > 0) s.spentGrant.set(scope, s.spentGrant.get(scope) + fromGrant) else s.spentGrant,
      poolDrawn: if (fromPool > 0) s.poolDrawn.set(scope, s.poolDrawn.get(scope) + fromPool) else s.poolDrawn,
      pooledSpent: s.pooledSpent + fromPool,
      billed: s.billed + chargeOf(amount),
      lastSpendUsedPool: fromPool > 0,
      lastSpendOwnAfter: ownAfter,
      spends: s.spends + 1,
    }
    if (fromPool > 0) reportPool(spent, s.pooled - fromPool) else spent
  }

  // A transfer is a spend on the source and a grant on the target in one move:
  // the source's plan units become the target's plan units and its lifetime
  // units become the target's lifetime units. The class is preserved, so a
  // transfer never turns a lifetime grant into an expiring one.
  pure def applyTransfer(s: State, from: Scope, target: Scope, amount: int): State = {
    val fromPlan = if (amount <= s.plan.get(from)) amount else s.plan.get(from)
    val fromGrant = amount - fromPlan
    {
      ...s,
      plan: s.plan.set(from, s.plan.get(from) - fromPlan).set(target, s.plan.get(target) + fromPlan),
      grant: s.grant.set(from, s.grant.get(from) - fromGrant).set(target, s.grant.get(target) + fromGrant),
      spentPlan: if (fromPlan > 0) s.spentPlan.set(from, s.spentPlan.get(from) + fromPlan) else s.spentPlan,
      spentGrant: if (fromGrant > 0) s.spentGrant.set(from, s.spentGrant.get(from) + fromGrant) else s.spentGrant,
      planIssued: if (fromPlan > 0) s.planIssued.set(target, s.planIssued.get(target) + fromPlan) else s.planIssued,
      grantIssued: if (fromGrant > 0) s.grantIssued.set(target, s.grantIssued.get(target) + fromGrant) else s.grantIssued,
      transfers: s.transfers.union(Set({ from: from, target: target, amount: amount })),
      transferCount: s.transferCount + 1,
    }
  }

  // The customer's close owns every attached scope's period. A plan source is
  // expired and replaced; a lifetime grant is not touched.
  pure def applyClose(s: State): State = {
    val closing = attachedScopes(s).filter(scope => s.plans.contains(scope))
    val expiredPlans = closing.fold(s.expired, (acc, scope) =>
      acc.set(scope, acc.get(scope) + s.plan.get(scope)))
    val resetPlans = closing.fold(s.plan, (acc, scope) => acc.set(scope, PLAN_GRANT))
    val issuedPlans = closing.fold(s.planIssued, (acc, scope) =>
      acc.set(scope, acc.get(scope) + PLAN_GRANT))
    val withPool =
      if (s.pooledGranted > 0)
        reportPool(
          {
            ...s,
            pooledExpired: s.pooledExpired + s.pooled,
            pooledGranted: s.pooledGranted + POOLED_GRANT,
          },
          POOLED_GRANT,
        )
      else s
    {
      ...withPool,
      expired: expiredPlans,
      plan: resetPlans,
      planIssued: issuedPlans,
      billed: 0,
      capLoweredBelowBill: false,
      now: s.periodEnd,
      periodEnd: s.periodEnd + PERIOD_LENGTH,
      closes: s.closes + 1,
    }
  }

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // Every unit a scope owns is accounted for: what it still holds, what it
  // spent, what it transferred out, and what its close expired. This is the
  // per-scope fold; a spend that debits a sibling breaks it even though the
  // customer's total would still add up.
  val scopedConservation: bool =
    SCOPES.forall(scope =>
      state.plan.get(scope) + state.grant.get(scope)
        + state.spentPlan.get(scope) + state.spentGrant.get(scope)
        + state.expired.get(scope)
        == state.planIssued.get(scope) + state.grantIssued.get(scope))

  // A lifetime grant's units are held or spent, never removed by a close, a
  // transfer or an archive.
  val lifetimeConserved: bool =
    SCOPES.forall(scope =>
      state.grant.get(scope) + state.spentGrant.get(scope) == state.grantIssued.get(scope))

  // The customer's total across its scopes and the shared pool is what it was
  // granted less what expired; a transfer moves units and changes nothing. The
  // terms include spent and expired, so a unit that left a balance is still
  // counted where it went.
  val totalConservedAcrossScopes: bool =
    SCOPES.fold(0, (acc, scope) =>
      acc + state.plan.get(scope) + state.grant.get(scope)
        + state.spentPlan.get(scope) + state.spentGrant.get(scope)
        + state.expired.get(scope))
      + state.pooled + state.pooledSpent + state.pooledExpired
      == SCOPES.fold(0, (acc, scope) =>
        acc + state.planIssued.get(scope) + state.grantIssued.get(scope))
        + state.pooledGranted

  // No scope's own source and no shared pool goes below zero. A transfer and a
  // spend are both refused before they overdraw.
  val entityBalancesNonNegative: bool =
    SCOPES.forall(scope => state.plan.get(scope) >= 0 and state.grant.get(scope) >= 0)
      and state.pooled >= 0

  // Both endpoints of every recorded transfer belong to this customer.
  val transferStaysInsideOneCustomer: bool =
    state.transfers.forall(transfer => owns(transfer.from) and owns(transfer.target))

  // The pooled grant is one source: every attached scope reports the same
  // remaining, and a spend by one scope lowers what the sibling sees.
  val pooledGrantShared: bool =
    attachedScopes(state).forall(scope => state.poolView.get(scope) == state.pooled)

  // An archived entity holds no plan, no lifetime grant and no pooled row. Its
  // leftovers went to the parent in the archive move.
  val archivedEntityHoldsNothing: bool =
    SCOPES.forall(scope =>
      state.status.get(scope) != Archived
        or (state.plan.get(scope) == 0
          and state.grant.get(scope) == 0
          and state.poolView.get(scope) == 0))

  // A scope reaches the shared pool only after its own plan and grant are empty.
  // A scope has no third source, so this is also "only own or pooled".
  val spendOnlyFromOwnOrPooled: bool =
    not(state.lastSpendUsedPool) or state.lastSpendOwnAfter == 0

  // Nothing leaves an archived scope: the scope's spend, transfer-out and pool
  // draw are exactly what they were when the archive swept it.
  val noSpendAfterArchive: bool =
    SCOPES.forall(scope =>
      state.status.get(scope) != Archived
        or drawnOf(state, scope) == state.spentAtArchive.get(scope))

  // The ceiling is a ceiling: a period's billed money never passes it, unless
  // the customer lowered the ceiling under money already billed. A ceiling
  // stops new spend; it never unbills history.
  val billedNeverExceedsCap: bool =
    not(state.hasCap) or state.billed <= state.cap or state.capLoweredBelowBill

  val entitiesInvariant: bool = and {
    scopedConservation,
    lifetimeConserved,
    totalConservedAcrossScopes,
    entityBalancesNonNegative,
    transferStaysInsideOneCustomer,
    pooledGrantShared,
    archivedEntityHoldsNothing,
    spendOnlyFromOwnOrPooled,
    noSpendAfterArchive,
    billedNeverExceedsCap,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  action attachEntity(scope: Scope): bool = all {
    ENTITIES.contains(scope),
    state.status.get(scope) == Detached,
    state' = applyAttachEntity(state, scope),
  }

  action archiveEntity(scope: Scope): bool = all {
    ENTITIES.contains(scope),
    attached(state, scope),
    state' = applyArchive(state, scope),
  }

  // A pooled item is attached on the parent; an entity-scoped item on its
  // entity. A pooled item on an entity would be a second pool.
  action attachPlan(scope: Scope, pooled: bool): bool = all {
    owns(scope),
    attached(state, scope),
    not(pooled) or scope == Parent,
    state' = applyAttachPlan(state, scope, pooled),
  }

  action grant(scope: Scope): bool = all {
    owns(scope),
    attached(state, scope),
    state' = applyGrant(state, scope),
  }

  action setCap(value: int): bool = all {
    value >= 0,
    state' = {
      ...state,
      hasCap: true,
      cap: value,
      capLoweredBelowBill: value < state.billed,
    },
  }

  action clearCap: bool = all {
    state' = { ...state, hasCap: false },
  }

  action spend(scope: Scope, amount: int): bool = all {
    owns(scope),
    attached(state, scope),
    amount > 0,
    amount <= ownOf(state, scope) + state.pooled,
    not(state.hasCap) or state.billed + chargeOf(amount) <= state.cap,
    state' = applySpend(state, scope, amount),
  }

  // A transfer addresses two scopes of one customer and only their own sources.
  // It never writes the pooled source, occupancy or a credit pool.
  action transfer(from: Scope, target: Scope, amount: int): bool = all {
    owns(from),
    owns(target),
    attached(state, from),
    attached(state, target),
    from != target,
    amount > 0,
    amount <= ownOf(state, from),
    state' = applyTransfer(state, from, target, amount),
  }

  action closePeriod: bool = all {
    state.now >= state.periodEnd,
    state' = applyClose(state),
  }

  action tick: bool = all {
    state.now + 1 <= state.periodEnd,
    state' = { ...state, now: state.now + 1 },
  }

  action step: bool = {
    nondet scope = ALL_SCOPES.oneOf()
    nondet other = ALL_SCOPES.oneOf()
    nondet entity = ENTITIES.oneOf()
    nondet amount = 1.to(6).oneOf()
    nondet pooled = Set(false, true).oneOf()
    nondet cap = 0.to(12).oneOf()
    any {
      attachEntity(entity),
      archiveEntity(entity),
      attachPlan(scope, pooled),
      grant(scope),
      setCap(cap),
      clearCap,
      spend(scope, amount),
      transfer(scope, other, amount),
      tick,
      closePeriod,
    }
  }

  action init: bool = all {
    state' = {
      now: 0,
      periodEnd: PERIOD_LENGTH,
      status: Map(
        Parent -> Attached,
        EntityA -> Detached,
        EntityB -> Detached,
        Foreign -> Attached,
      ),
      plan: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> FOREIGN_BALANCE),
      grant: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> 0),
      spentPlan: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> 0),
      spentGrant: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> 0),
      expired: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> 0),
      planIssued: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> FOREIGN_BALANCE),
      grantIssued: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> 0),
      pooled: 0,
      pooledGranted: 0,
      pooledSpent: 0,
      pooledExpired: 0,
      poolView: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> 0),
      poolDrawn: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> 0),
      hasCap: false,
      cap: 0,
      billed: 0,
      capLoweredBelowBill: false,
      lastSpendUsedPool: false,
      lastSpendOwnAfter: 0,
      spentAtArchive: Map(Parent -> 0, EntityA -> 0, EntityB -> 0, Foreign -> 0),
      plans: Set(),
      transfers: Set(),
      attaches: 0,
      archives: 0,
      planAttaches: 0,
      grants: 0,
      spends: 0,
      transferCount: 0,
      closes: 0,
    },
  }

  // ── witnesses ──────────────────────────────────────────────────────────────

  val entityAttached: bool = state.status.get(EntityA) == Attached

  val entityPlan: bool = state.plans.contains(EntityA) and state.planIssued.get(EntityA) > 0

  val entityGranted: bool = state.grantIssued.get(EntityA) > 0

  val pooledGranted: bool = state.pooledGranted > 0

  val poolDrawnByTwoEntities: bool =
    state.poolDrawn.get(EntityA) > 0 and state.poolDrawn.get(EntityB) > 0

  val ownSpent: bool = spentOf(state, EntityA) > 0

  val billedSpend: bool = state.billed > 0

  val splitDrawBilled: bool =
    SCOPES.exists(scope => state.poolDrawn.get(scope) > 0 and spentOf(state, scope) > 0)
      and state.billed > 0

  val capLoweredBelowBillReached: bool = state.capLoweredBelowBill

  val transferred: bool = state.transferCount > 0

  val transferredLifetime: bool =
    state.transferCount > 0
      and SCOPES.exists(scope => state.grant.get(scope) > 0 and state.grantIssued.get(scope) > state.grant.get(scope))

  val archived: bool = state.archives > 0

  val closed: bool = state.closes > 0

  val expiredAtClose: bool = state.closes > 0 and SCOPES.exists(scope => state.expired.get(scope) > 0)

  val lifetimeSurvivedClose: bool =
    state.closes > 0
      and SCOPES.exists(scope => state.grantIssued.get(scope) > 0 and state.grant.get(scope) > 0)
}
