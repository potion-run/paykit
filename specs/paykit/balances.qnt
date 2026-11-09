// A Quint model of the balance ledger: the sources a feature's balance comes
// from, the order a spend consumes them, and what a boundary or a plan change
// does to each source.
//
// This is the fifth protocol. `paykit.qnt` models the spend path against one
// count, `windows.qnt` the clocks the period does not own, and this model the
// list of sources behind one count: a plan source, a rollover, an expiring
// grant, and a lifetime grant. The grant slots are fixed because the invariant
// is the order, not the cardinality; a real customer may hold many grants, and
// they collapse into the same two classes by expiry.
//
// Source correspondence:
//   createGrant       ↔ GrantBalance.command.ts / balances.create
//   spend             ↔ TrackUsage.command.ts, and a hold's source allocation
//   closePeriod       ↔ ClosePeriod.command.ts (UsageReset / PlanItemReset)
//   changePlan        ↔ ChangeTier.command.ts (the plan source is replaced)
//   expireGrant       ↔ a grant's expiresAt
//   tick              ↔ the platform clock
//
// Scope and the code divergences are in README.md beside this file. The
// arithmetic of a rollover is `paykit.qnt`'s job; this model says which source
// a spend takes from and what a boundary preserves.
module balances {

  // ── types ──────────────────────────────────────────────────────────────────

  type State = {
    now: int,
    periodEnd: int,
    // The plan source: what the period includes, what is left, and the
    // rollover the last boundary carried.
    included: int,
    plan: int,
    rollover: int,
    // The two grant classes. An expiring grant has a deadline; a lifetime grant
    // outlives every close, plan change and expiry.
    expiring: int,
    lifetime: int,
    expiringAt: int,
    // History, so conservation and the order are checkable rather than
    // asserted on the current numbers alone.
    expiringGranted: int,
    expiringSpent: int,
    expiringExpired: int,
    lifetimeGranted: int,
    lifetimeSpent: int,
    spentFromPlan: int,
    spentFromGrant: int,
    lastSpendUsedGrant: bool,
    lastSpendPlan: int,
    carried: int,
    maxCarried: int,
    expiries: int,
    closes: int,
    changes: int,
    expired: bool,
  }

  pure val PERIOD_LENGTH: int = 5
  pure val CARRY_CAP: int = 2
  pure val INCLUDED: int = 4
  pure val GRANT_SIZE: int = 3
  pure val EXPIRY: int = 3
  pure val MAX_TIME: int = 20

  pure def total(s: State): int = s.plan + s.rollover + s.expiring + s.lifetime

  pure def planPart(s: State): int = s.plan + s.rollover

  pure def grantTotal(s: State): int = s.expiring + s.lifetime

  pure def canSpend(s: State, amount: int): bool = amount > 0 and amount <= total(s)

  // The one deduction order: plan, rollover, an expiring grant, then the
  // lifetime grant. A spend that reaches a grant records that it saw no plan or
  // rollover left, which is the rule `grantSpentOnlyAfterPlan` checks.
  pure def applySpend(s: State, amount: int): State = {
    val fromPlan = if (amount <= s.plan) amount else s.plan
    val afterPlan = amount - fromPlan
    val fromRollover = if (afterPlan <= s.rollover) afterPlan else s.rollover
    val afterRollover = afterPlan - fromRollover
    val fromExpiring = if (afterRollover <= s.expiring) afterRollover else s.expiring
    val fromLifetime = afterRollover - fromExpiring
    {
      ...s,
      plan: s.plan - fromPlan,
      rollover: s.rollover - fromRollover,
      expiring: s.expiring - fromExpiring,
      lifetime: s.lifetime - fromLifetime,
      expiringSpent: s.expiringSpent + fromExpiring,
      lifetimeSpent: s.lifetimeSpent + fromLifetime,
      spentFromPlan: s.spentFromPlan + fromPlan + fromRollover,
      spentFromGrant: s.spentFromGrant + fromExpiring + fromLifetime,
      lastSpendUsedGrant: fromExpiring + fromLifetime > 0,
      // What was left of the plan and rollover *after* this spend. The order
      // invariant is that a grant was touched only when this is zero.
      lastSpendPlan: s.plan + s.rollover - fromPlan - fromRollover,
    }
  }

  // A grant is created after the plan, so it is never spent while the plan has
  // room. A lifetime grant is independent of the plan for the rest of its life.
  pure def applyGrant(s: State, lifetime: bool): State = {
    ...s,
    expiring: if (lifetime) s.expiring else s.expiring + GRANT_SIZE,
    lifetime: if (lifetime) s.lifetime + GRANT_SIZE else s.lifetime,
    expiringGranted: if (lifetime) s.expiringGranted else s.expiringGranted + GRANT_SIZE,
    lifetimeGranted: if (lifetime) s.lifetimeGranted + GRANT_SIZE else s.lifetimeGranted,
    // A new expiring grant starts a new deadline; the old one is no longer the
    // grant `expiryIsFinal` is talking about.
    expired: if (lifetime) s.expired else false,
  }

  // A close resets the plan to what it includes and rolls the plan's unused
  // units into a rollover, capped. The rollover carries forward too, capped.
  // Every grant is left alone.
  pure def applyClose(s: State): State = {
    val carried = if (s.plan > CARRY_CAP) CARRY_CAP else s.plan
    val nextRollover = s.rollover + carried
    {
      ...s,
      plan: s.included,
      rollover: if (nextRollover > CARRY_CAP) CARRY_CAP else nextRollover,
      carried: carried,
      maxCarried: if (carried > s.maxCarried) carried else s.maxCarried,
      closes: s.closes + 1,
      now: s.periodEnd,
      periodEnd: s.periodEnd + PERIOD_LENGTH,
    }
  }

  // A plan change replaces the plan source. The rollover belongs to the plan's
  // history, so a change starts with none; every grant survives.
  pure def applyChangePlan(s: State): State = {
    ...s,
    plan: INCLUDED,
    rollover: 0,
    changes: s.changes + 1,
  }

  // The expiring grant's deadline passes. The units leave the source and stay
  // in the expired counter, so `expiringConserved` can see them.
  pure def applyExpire(s: State): State = {
    ...s,
    expiring: 0,
    expiringExpired: s.expiringExpired + s.expiring,
    expired: true,
    expiries: s.expiries + 1,
  }

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  val sourcesNonNegative: bool =
    state.plan >= 0 and state.rollover >= 0 and state.expiring >= 0 and state.lifetime >= 0

  val totalNonNegative: bool = total(state) >= 0

  // A spend that reached a grant saw no plan or rollover left. That is the
  // order: plan and add-on sources before rollover, rollover before a lifetime
  // grant.
  val grantSpentOnlyAfterPlan: bool =
    not(state.lastSpendUsedGrant) or state.lastSpendPlan == 0

  // A close carries at most the cap, and no rollover ever exceeds it.
  val rolloverBounded: bool = state.rollover <= CARRY_CAP

  val carriedWithinCap: bool = state.maxCarried <= CARRY_CAP

  // An expiring grant's units are spent or expired, never dropped.
  val expiringConserved: bool =
    state.expiring + state.expiringSpent + state.expiringExpired == state.expiringGranted

  // A lifetime grant's units are spent, never destroyed by a close or a plan
  // change. This is the invariant a `lifetime: 0` in either action breaks.
  val lifetimeConserved: bool =
    state.lifetime + state.lifetimeSpent == state.lifetimeGranted

  val expiryIsFinal: bool = not(state.expired) or state.expiring == 0

  val balancesInvariant: bool = and {
    sourcesNonNegative,
    totalNonNegative,
    grantSpentOnlyAfterPlan,
    rolloverBounded,
    carriedWithinCap,
    expiringConserved,
    lifetimeConserved,
    expiryIsFinal,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  action spend(amount: int): bool = all {
    canSpend(state, amount),
    state' = applySpend(state, amount),
  }

  action createGrant(lifetime: bool): bool = all {
    state' = applyGrant(state, lifetime),
  }

  action closePeriod: bool = all {
    state.now >= state.periodEnd,
    state' = applyClose(state),
  }

  action changePlan: bool = all {
    state' = applyChangePlan(state),
  }

  action expireGrant: bool = all {
    state.now >= state.expiringAt,
    not(state.expired),
    state.expiring > 0,
    state' = applyExpire(state),
  }

  action tick: bool = all {
    state.now < MAX_TIME,
    state' = { ...state, now: state.now + 1 },
  }

  action step: bool = {
    nondet amount = 1.to(6).oneOf()
    nondet lifetime = Set(false, true).oneOf()
    any {
      spend(amount),
      createGrant(lifetime),
      closePeriod,
      changePlan,
      expireGrant,
      tick,
    }
  }

  action init: bool = all {
    state' = {
      now: 0,
      periodEnd: PERIOD_LENGTH,
      included: INCLUDED,
      plan: INCLUDED,
      rollover: 0,
      expiring: 0,
      lifetime: 0,
      expiringAt: EXPIRY,
      expiringGranted: 0,
      expiringSpent: 0,
      expiringExpired: 0,
      lifetimeGranted: 0,
      lifetimeSpent: 0,
      spentFromPlan: 0,
      spentFromGrant: 0,
      lastSpendUsedGrant: false,
      lastSpendPlan: 0,
      carried: 0,
      maxCarried: 0,
      expiries: 0,
      closes: 0,
      changes: 0,
      expired: false,
    },
  }

  // ── witnesses ──────────────────────────────────────────────────────────────

  val granted: bool = state.expiringGranted + state.lifetimeGranted > 0

  val grantedLifetime: bool = state.lifetimeGranted > 0

  val spentPlan: bool = state.spentFromPlan > 0

  val spentGrant: bool = state.spentFromGrant > 0

  val rolledOver: bool = state.rollover > 0

  val closed: bool = state.closes > 0

  val changedPlan: bool = state.changes > 0 and state.lifetimeGranted > 0

  val expiredGrant: bool = state.expiries > 0

  val fullySpent: bool = total(state) == 0

  val lifetimeSurvivedClose: bool =
    state.closes > 0 and state.lifetimeGranted > 0 and state.lifetime > 0
}
