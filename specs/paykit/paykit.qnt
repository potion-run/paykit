// A Quint model of the `Subscription` aggregate's spend path: what a period
// includes, what a usage fact may record, what a hold reserves, and what the
// credit pool can cover. It is the machine `src/Subscription/*.command.ts`
// implements, with the money and the clock abstracted.
//
// Scope, the source-file map, and the known gaps are in README.md beside this
// file. Read that before changing this one: the spec is the ground truth for
// the invariants it names, and the code is the ground truth for everything it
// leaves out.
//
// Correspondence: every action is named after the command it models.
//   subscribe      ↔ Subscribe.command.ts          (SubscriptionActivated)
//   trackUsage     ↔ TrackUsage.command.ts         (UsageRecorded)
//   consumeCredits ↔ ConsumeCredits.command.ts     (CreditsConsumed)
//   hold           ↔ Hold.command.ts               (UsageReserved)
//   settleHold     ↔ SettleHold.command.ts         (UsageRecorded + UsageSettled)
//   releaseHold    ↔ ReleaseHold.command.ts        (UsageReleased, reason released)
//   expireHold     ↔ HoldElapsed.command.ts        (UsageReleased, reason expired)
//   enterGrace     ↔ EnterGrace.command.ts         (GraceEntered)
//   recover        ↔ Recover.command.ts            (Recovered)
//   cancelStanding ↔ ScheduleCancellation.command.ts + Expire.command.ts
//   tick           ↔ the platform clock the policy scheduler runs on
module paykit {

  // ── types ──────────────────────────────────────────────────────────────────

  // `Unsubscribed` is the model's stand-in for the aggregate's `initial` state;
  // `Canceled` is any terminal status (ADR 0020), and a terminal standing never
  // spends again.
  type Status = Unsubscribed | Active | Grace | Canceled

  // What happens past `included`. `Block` is the only overage that runs out
  // (ADR 0009); `Bill` records past it.
  type Overage = Block | Bill

  // `Available` is the model's stand-in for "this standing never took a hold
  // with this id" — the aggregate keys `holds` by id and the absence of a key is
  // not a status. A closed hold stays as an audit record, so its id is never
  // available again.
  type HoldStatus = Available | Open | Settled | Released | ExpiredHold

  type FeatureId = str
  type HoldId = str

  // One tier's grant for one feature. `creditRate` is `-1` when the feature is
  // counted in its own units and the shared pool does not price it.
  type Allowance = {
    overage: Overage,
    included: int,
    creditRate: int,
  }

  // One hold. `rate` is captured when the hold is taken, so a catalogue change
  // mid-flight does not reprice work already promised.
  type Hold = {
    feature: FeatureId,
    amount: int,
    rate: int,
    cost: int,
    expiresAt: int,
    status: HoldStatus,
  }

  type State = {
    status: Status,
    now: int,
    allowances: FeatureId -> Allowance,
    // The counted features' spendable units. A credit-priced feature's count is
    // the pool (see `spendableOf`), so its entry here stays `0`.
    remaining: FeatureId -> int,
    // Units for a counted feature, credits for a credit-priced one — the same
    // split `UsageRecorded.usedAfter` records.
    used: FeatureId -> int,
    credits: int,
    // Credits spent through `ConsumeCredits`, which names no feature. The
    // aggregate has no field for this — the log does (`CreditsConsumed`) — and
    // the pool's conservation law needs it, so the model keeps it as a history
    // variable.
    consumed: int,
    holds: HoldId -> Hold,
  }

  // ── the catalogue and the clock ────────────────────────────────────────────

  pure val FEATURES: Set[FeatureId] = Set("messages", "requests", "compute")
  pure val HOLDS: Set[HoldId] = Set("hold-a", "hold-b")
  pure val AMOUNTS: Set[int] = Set(1, 2, 3, 4)

  pure val MESSAGES_INCLUDED: int = 10
  pure val REQUESTS_INCLUDED: int = 2
  pure val COMPUTE_RATE: int = 3
  pure val CREDITS_GRANTED: int = 20

  // How long a hold stays settleable. A real deployment sets a deadline
  // (ADR 0021); the model only needs it to be finite.
  pure val HOLD_TTL: int = 4

  // The deadline a `tick` may not pass. A standing with nothing open has no
  // deadline, so the clock is free.
  pure val NO_DEADLINE: int = 1000000

  pure val EMPTY_HOLDS: HoldId -> Hold =
    HOLDS.mapBy(id => {
      feature: "", amount: 0, rate: 0, cost: 0, expiresAt: 0, status: Available,
    })

  pure def allowanceOf(feature: FeatureId): Allowance =
    if (feature == "messages") { overage: Block, included: MESSAGES_INCLUDED, creditRate: -1 }
    else if (feature == "requests") { overage: Bill, included: REQUESTS_INCLUDED, creditRate: -1 }
    else { overage: Bill, included: 0, creditRate: COMPUTE_RATE }

  pure def isCreditPriced(allowance: Allowance): bool = allowance.creditRate >= 0

  // `allowsUsage` in Subscription.state.ts: a trial, an active standing and a
  // grace window all record usage; a terminal one does not.
  pure def allowsUsage(status: Status): bool = status == Active or status == Grace

  // ── folds over the holds ───────────────────────────────────────────────────

  pure def openHolds(holds: HoldId -> Hold): Set[HoldId] =
    HOLDS.filter(id => holds.get(id).status == Open)

  // The credits open holds keep out of the pool (`reservedCreditsOf`).
  pure def reservedCredits(holds: HoldId -> Hold): int =
    openHolds(holds).fold(0, (acc, id) => acc + holds.get(id).cost)

  // The units open holds keep out of one counted feature's remaining
  // (`reservedOf`).
  pure def reservedUnits(holds: HoldId -> Hold, feature: FeatureId): int =
    openHolds(holds)
      .filter(id => holds.get(id).feature == feature)
      .fold(0, (acc, id) => acc + holds.get(id).amount)

  // The earliest deadline an open hold is waiting on, or `NO_DEADLINE`.
  pure def nextDeadline(holds: HoldId -> Hold): int =
    openHolds(holds).fold(NO_DEADLINE, (acc, id) =>
      if (holds.get(id).expiresAt < acc) holds.get(id).expiresAt else acc)

  // ── what a caller may spend ────────────────────────────────────────────────

  // What `availableOf` answers: a counted feature's `remaining`, or the pool
  // less every open hold for a credit-priced one. A credit-priced feature's
  // count is therefore derived rather than stored: the aggregate's stored copy
  // is a cache that `ConsumeCredits` leaves stale (see README, "what this model
  // does not reproduce"), and nothing observable reads it.
  pure def spendableOf(s: State, feature: FeatureId): int =
    if (isCreditPriced(s.allowances.get(feature)))
      s.credits - reservedCredits(s.holds)
    else s.remaining.get(feature)

  // `capacityOf` for one feature: the standing first, then the pool or the
  // count. A `bill` allowance never runs out of units, so only the pool and the
  // standing can refuse it.
  pure def canSpendCounted(allowance: Allowance, remaining: int, amount: int): bool =
    amount > 0 and (allowance.overage == Bill or amount <= remaining)

  pure def canSpendCredits(allowance: Allowance, s: State, amount: int): bool =
    amount > 0 and amount * allowance.creditRate <= s.credits - reservedCredits(s.holds)

  pure def canSpend(s: State, feature: FeatureId, amount: int): bool = {
    val allowance = s.allowances.get(feature)
    if (isCreditPriced(allowance))
      canSpendCredits(allowance, s, amount)
    else canSpendCounted(allowance, s.remaining.get(feature), amount)
  }

  // ── what spending produces ─────────────────────────────────────────────────

  // `TrackUsage`: a counted feature moves its own counter; a credit-priced one
  // spends `amount × rate` credits and counts the credits it spent.
  pure def spend(s: State, feature: FeatureId, amount: int): State = {
    val allowance = s.allowances.get(feature)
    if (isCreditPriced(allowance))
      {
        val cost = amount * allowance.creditRate
        {
          ...s,
          credits: s.credits - cost,
          used: s.used.set(feature, s.used.get(feature) + cost),
        }
      }
    else
      {
        ...s,
        remaining: s.remaining.set(feature, s.remaining.get(feature) - amount),
        used: s.used.set(feature, s.used.get(feature) + amount),
      }
  }

  // ── holds ──────────────────────────────────────────────────────────────────

  pure def canHold(s: State, id: HoldId, feature: FeatureId, amount: int): bool = and {
    s.holds.get(id).status == Available,
    canSpend(s, feature, amount),
  }

  // `Hold`: the units (or the credits) leave `remaining` now and come back at
  // settle for whatever was not billed. A counted hold takes its own units and
  // costs nothing.
  pure def takeHold(s: State, id: HoldId, feature: FeatureId, amount: int): State = {
    val allowance = s.allowances.get(feature)
    val rate = if (isCreditPriced(allowance)) allowance.creditRate else 0
    val requested = if (isCreditPriced(allowance)) amount * rate else amount
    {
      ...s,
      remaining: s.remaining.set(feature, s.remaining.get(feature) - requested),
      holds: s.holds.set(id, {
        feature: feature,
        amount: amount,
        rate: rate,
        cost: amount * rate,
        expiresAt: s.now + HOLD_TTL,
        status: Open,
      }),
    }
  }

  // `SettleHold`: a settle at or past the deadline is refused, one on a closed
  // hold records nothing, and the units the work did not bill return in the
  // same command. A terminal standing may not settle — its holds are released
  // or swept instead (ADR 0021).
  pure def canSettle(s: State, id: HoldId, billed: int): bool = {
    val hold = s.holds.get(id)
    and {
      hold.status == Open,
      allowsUsage(s.status),
      s.now < hold.expiresAt,
      billed >= 0,
      billed <= hold.amount,
    }
  }

  pure def settle(s: State, id: HoldId, billed: int): State = {
    val hold = s.holds.get(id)
    val creditPriced = isCreditPriced(s.allowances.get(hold.feature))
    val returned = if (creditPriced) (hold.amount - billed) * hold.rate else hold.amount - billed
    val spent = if (creditPriced) billed * hold.rate else billed
    {
      ...s,
      credits: if (creditPriced) s.credits - spent else s.credits,
      remaining: s.remaining.set(hold.feature, s.remaining.get(hold.feature) + returned),
      used: s.used.set(hold.feature, s.used.get(hold.feature) + spent),
      holds: s.holds.set(id, { ...hold, status: Settled }),
    }
  }

  // The one cleanup both a release and a sweep perform: the hold returns what
  // it took, in whatever unit it took it.
  pure def closeHold(s: State, id: HoldId, status: HoldStatus): State = {
    val hold = s.holds.get(id)
    val returned =
      if (isCreditPriced(s.allowances.get(hold.feature))) hold.cost else hold.amount
    {
      ...s,
      remaining: s.remaining.set(hold.feature, s.remaining.get(hold.feature) + returned),
      holds: s.holds.set(id, { ...hold, status: status }),
    }
  }

  // A release is always available for an open hold, whatever the standing: a
  // cleanup is not a spend, and a hold left open by a cancellation must still
  // be closable (ADR 0021).
  pure def canRelease(s: State, id: HoldId): bool =
    s.holds.get(id).status == Open

  // `HoldElapsed` fires at the deadline and returns the hold — it does not
  // depend on the standing either.
  pure def canExpireHold(s: State, id: HoldId): bool = {
    val hold = s.holds.get(id)
    hold.status == Open and s.now >= hold.expiresAt
  }

  // ── the shared pool ────────────────────────────────────────────────────────

  // `ConsumeCredits`: what open holds reserved is not spendable here, so settle
  // still has credits to bill.
  pure def canConsumeCredits(s: State, amount: int): bool =
    amount > 0 and amount <= s.credits - reservedCredits(s.holds)

  pure def applyConsumeCredits(s: State, amount: int): State = {
    ...s,
    credits: s.credits - amount,
    consumed: s.consumed + amount,
  }

  pure def canSubscribe(s: State): bool = s.status == Unsubscribed

  pure def activate(s: State): State = {
    ...s,
    status: Active,
    remaining: FEATURES.mapBy(feature =>
      if (isCreditPriced(allowanceOf(feature))) 0 else allowanceOf(feature).included),
    used: FEATURES.mapBy(feature => 0),
    credits: CREDITS_GRANTED,
    consumed: 0,
  }

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // What a period conserves: every unit a feature included is accounted for as
  // remaining, used, or held. This is the one that catches a release that
  // forgets to return, a settle that returns twice, and a hold that writes
  // `remaining` without taking anything.
  val countedConserved: bool =
    FEATURES.filter(f => not(isCreditPriced(state.allowances.get(f)))).forall(f =>
      state.remaining.get(f) + state.used.get(f) + reservedUnits(state.holds, f)
        == state.allowances.get(f).included)

  // Usage only ever moves forward: a settle cannot bill a negative amount, and a
  // release cannot un-use anything.
  val noNegativeUsage: bool =
    FEATURES.forall(f => state.used.get(f) >= 0)

  // A blocking allowance is never oversubscribed. `Bill` may pass `included`,
  // which is why only the blocking features are asserted (ADR 0009).
  val blockingNeverOversubscribed: bool =
    FEATURES.filter(f => {
      val allowance = state.allowances.get(f)
      not(isCreditPriced(allowance)) and allowance.overage == Block
    }).forall(f => state.remaining.get(f) >= 0)

  // The pool covers every open hold: settle has credits to bill, so the pool
  // never needs a negative balance to explain a reservation.
  val creditsCoverEveryHold: bool =
    state.credits >= reservedCredits(state.holds)

  // The pool is a fold of the log, one balance for every credit-priced feature:
  // what a feature spent, plus what a command consumed outright, plus what is
  // left is exactly what activation granted. Gated on activation because an
  // unsubscribed standing holds no pool.
  val creditPoolConserved: bool =
    state.status == Unsubscribed or (
      state.credits + state.used.get("compute") + state.consumed == CREDITS_GRANTED)

  // A hold is one amount: the credits it reserved are the units it holds times
  // the rate it was priced at, and nothing can change one without the other.
  val holdCostIsAmountTimesRate: bool =
    openHolds(state.holds).forall(id =>
      state.holds.get(id).cost == state.holds.get(id).amount * state.holds.get(id).rate)

  // The scheduler is never behind: the clock does not pass a deadline with a
  // hold still open. This is the assumption `tick` encodes, and it is what makes
  // ADR 0021's "a hold has a deadline" a fact about every reachable state.
  val noHoldPastDeadline: bool =
    openHolds(state.holds).forall(id => state.now <= state.holds.get(id).expiresAt)

  val paykitInvariant: bool = and {
    countedConserved,
    noNegativeUsage,
    blockingNeverOversubscribed,
    creditsCoverEveryHold,
    creditPoolConserved,
    holdCostIsAmountTimesRate,
    noHoldPastDeadline,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  // One action per command. A command that would be refused is modelled as a
  // disabled action — `quint` never reports the rejection tag, so the spec
  // checks the accept-set and the named tests in `paykit_test.qnt` check that
  // the refusal holds.

  action subscribe: bool = all {
    canSubscribe(state),
    state' = activate(state),
  }

  action trackUsage(feature: FeatureId, amount: int): bool = all {
    allowsUsage(state.status),
    canSpend(state, feature, amount),
    state' = spend(state, feature, amount),
  }

  action consumeCredits(amount: int): bool = all {
    allowsUsage(state.status),
    canConsumeCredits(state, amount),
    state' = applyConsumeCredits(state, amount),
  }

  action hold(id: HoldId, feature: FeatureId, amount: int): bool = all {
    allowsUsage(state.status),
    canHold(state, id, feature, amount),
    state' = takeHold(state, id, feature, amount),
  }

  action settleHold(id: HoldId, billed: int): bool = all {
    canSettle(state, id, billed),
    state' = settle(state, id, billed),
  }

  action releaseHold(id: HoldId): bool = all {
    canRelease(state, id),
    state' = closeHold(state, id, Released),
  }

  action expireHold(id: HoldId): bool = all {
    canExpireHold(state, id),
    state' = closeHold(state, id, ExpiredHold),
  }

  // The operator moves ADR 0020 allows, so the standing guard is exercised
  // rather than assumed: grace still spends, a terminal standing does not.
  action enterGrace: bool = all {
    state.status == Active,
    state' = { ...state, status: Grace },
  }

  action recover: bool = all {
    state.status == Grace,
    state' = { ...state, status: Active },
  }

  action cancelStanding: bool = all {
    allowsUsage(state.status),
    state' = { ...state, status: Canceled },
  }

  // Time. The clock stops at the next open deadline instead of passing it: the
  // sweep is dispatched at that deadline, so a hold is never overdue. This is
  // the model's one scheduling assumption and `noHoldPastDeadline` is its
  // statement.
  action tick: bool = all {
    state.now + 1 <= nextDeadline(state.holds),
    state' = { ...state, now: state.now + 1 },
  }

  action step: bool = {
    nondet feature = FEATURES.oneOf()
    nondet id = HOLDS.oneOf()
    nondet amount = AMOUNTS.oneOf()
    nondet billed = 0.to(4).oneOf()
    any {
      subscribe,
      trackUsage(feature, amount),
      consumeCredits(amount),
      hold(id, feature, amount),
      settleHold(id, billed),
      releaseHold(id),
      expireHold(id),
      enterGrace,
      recover,
      cancelStanding,
      tick,
    }
  }

  action init: bool = all {
    state' = {
      status: Unsubscribed,
      now: 0,
      allowances: FEATURES.mapBy(feature => allowanceOf(feature)),
      remaining: FEATURES.mapBy(feature =>
        if (isCreditPriced(allowanceOf(feature))) 0 else allowanceOf(feature).included),
      used: FEATURES.mapBy(feature => 0),
      credits: 0,
      consumed: 0,
      holds: EMPTY_HOLDS,
    },
  }

  // ── witnesses ──────────────────────────────────────────────────────────────

  // A witness names a state and asks whether it is reachable. `0%` means the
  // action behind it is dead, so fix that before trusting the invariant above.

  val messagesUsed: bool = state.used.get("messages") > 0

  val requestsBilledPastIncluded: bool = state.used.get("requests") > REQUESTS_INCLUDED

  val creditsSpentByUsage: bool = state.used.get("compute") > 0

  val creditsConsumedDirectly: bool = state.consumed > 0

  val holdOpen: bool = openHolds(state.holds).size() > 0

  val holdSettled: bool = HOLDS.exists(id => state.holds.get(id).status == Settled)

  val holdReleased: bool = HOLDS.exists(id => state.holds.get(id).status == Released)

  val holdExpired: bool = HOLDS.exists(id => state.holds.get(id).status == ExpiredHold)

  // A release is a cleanup, not a spend, so it works while the standing still
  // spends and after it stops. The second is the one ADR 0021 promises: a hold
  // taken before a cancellation is still closable after it.
  val holdReleasedWhileActive: bool =
    allowsUsage(state.status) and HOLDS.exists(id =>
      state.holds.get(id).status == Released)

  val holdReleasedWhileCanceled: bool =
    state.status == Canceled and HOLDS.exists(id =>
      state.holds.get(id).status == Released)

  val standingInGrace: bool = state.status == Grace
}
