// A Quint model of the `Subscription` aggregate's spend path: what a period
// includes, what a usage fact may record, what a hold reserves, what the credit
// pool can cover, and what a period boundary carries into the next one. It is
// the machine `src/Subscription/*.command.ts` implements, with the money and the
// clock abstracted.
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
//   closePeriod    ↔ ClosePeriod.command.ts, PeriodEnded.command.ts
//                                                  (UsageReleased reason reset +
//                                                   PeriodClosed + UsageReset +
//                                                   CreditsExpired)
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

  // Whether a boundary resets a counted allowance, or leaves it alone. `Never`
  // is `resets: "never"` — a lifetime count for the tier it was recorded on.
  type Reset = PerPeriod | Never

  // `Available` is the model's stand-in for "this standing never took a hold
  // with this id" — the aggregate keys `holds` by id and the absence of a key is
  // not a status. A boundary that resets a feature removes its holds outright,
  // so the id is available again in the next period; a release or a settle keeps
  // the record and the id is spent for good.
  type HoldStatus = Available | Open | Settled | Released | ExpiredHold

  type FeatureId = str
  type HoldId = str

  // One tier's grant for one feature. `creditRate` is `-1` when the feature is
  // counted in its own units and the shared pool does not price it.
  // `carriedCap` is `-1` when the allowance does not carry, and the most a
  // boundary may roll over when it does.
  type Allowance = {
    overage: Overage,
    included: int,
    creditRate: int,
    carriedCap: int,
    resets: Reset,
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
    // The boundary of the open period. A close moves it by `PERIOD_LENGTH`.
    periodEnd: int,
    allowances: FeatureId -> Allowance,
    // The counted features' spendable units. A credit-priced feature's count is
    // the pool (see `spendableOf`), so its entry here stays `0`.
    remaining: FeatureId -> int,
    // Units for a counted feature, credits for a credit-priced one — the same
    // split `UsageRecorded.usedAfter` records. A close zeroes every feature it
    // resets, so this is a per-period counter.
    used: FeatureId -> int,
    // What the open period started with beyond `included`: the units a
    // boundary rolled over. The period's base is `included + carried`, which is
    // what the conservation law below subtracts from.
    carried: FeatureId -> int,
    credits: int,
    // Lifetime credits spent by a credit-priced feature, consumed through
    // `ConsumeCredits`, and expired at a boundary. The pool is the fold of those
    // against the grant; `used` cannot serve, because a close zeroes it.
    spent: int,
    consumed: int,
    expired: int,
    holds: HoldId -> Hold,
  }

  // ── the catalogue and the clock ────────────────────────────────────────────

  pure val FEATURES: Set[FeatureId] = Set("messages", "requests", "storage", "compute")
  pure val HOLDS: Set[HoldId] = Set("hold-a", "hold-b")
  pure val AMOUNTS: Set[int] = Set(1, 2, 3, 4)

  // The four shapes a counted allowance can have (or three, plus the pool):
  // blocking with a rollover, billing with none, and one that outlives every
  // boundary.
  pure val MESSAGES_INCLUDED: int = 10
  pure val MESSAGES_CARRIED_CAP: int = 6
  pure val REQUESTS_INCLUDED: int = 2
  pure val STORAGE_INCLUDED: int = 4
  pure val COMPUTE_RATE: int = 3
  pure val CREDITS_GRANTED: int = 20

  // How long a hold stays settleable. A real deployment sets a deadline
  // (ADR 0021); the model only needs it to be finite.
  pure val HOLD_TTL: int = 4

  // How long a period is. Shorter than two hold deadlines, so a boundary lands
  // while a hold is open — the case a close has to answer for.
  pure val PERIOD_LENGTH: int = 5

  // The deadline a `tick` may not pass. A standing with nothing pending has no
  // deadline, so the clock is free.
  pure val NO_DEADLINE: int = 1000000

  pure val EMPTY_HOLDS: HoldId -> Hold =
    HOLDS.mapBy(id => {
      feature: "", amount: 0, rate: 0, cost: 0, expiresAt: 0, status: Available,
    })

  pure def allowanceOf(feature: FeatureId): Allowance =
    if (feature == "messages")
      {
        overage: Block,
        included: MESSAGES_INCLUDED,
        creditRate: -1,
        carriedCap: MESSAGES_CARRIED_CAP,
        resets: PerPeriod,
      }
    else if (feature == "requests")
      {
        overage: Bill,
        included: REQUESTS_INCLUDED,
        creditRate: -1,
        carriedCap: -1,
        resets: PerPeriod,
      }
    else if (feature == "storage")
      {
        overage: Block,
        included: STORAGE_INCLUDED,
        creditRate: -1,
        carriedCap: -1,
        resets: Never,
      }
    else
      {
        overage: Bill, included: 0, creditRate: COMPUTE_RATE, carriedCap: -1,
        resets: PerPeriod,
      }

  pure def isCreditPriced(allowance: Allowance): bool = allowance.creditRate >= 0

  // `resets: "never"`: a boundary leaves the counter, its holds and its
  // remainder exactly where they were.
  pure def isKeptOnClose(allowance: Allowance): bool = allowance.resets == Never

  pure def carriesOver(allowance: Allowance): bool = allowance.carriedCap >= 0

  // How much of a closing period's remainder the next one may keep. A feature
  // that does not carry, a kept one, and the pool carry nothing.
  pure def carriedCapOf(allowance: Allowance): int =
    if (carriesOver(allowance) and not(isKeptOnClose(allowance)) and not(isCreditPriced(allowance)))
      allowance.carriedCap
    else 0

  // `allowsUsage` in Subscription.state.ts: a trial, an active standing and a
  // grace window all record usage; a terminal one does not.
  pure def allowsUsage(status: Status): bool = status == Active or status == Grace

  // `rollsPeriod`: a terminal standing opens no further periods.
  pure def rollsPeriod(status: Status): bool = allowsUsage(status)

  pure def clamp(value: int, low: int, high: int): int =
    if (value < low) low else if (value > high) high else value

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
  pure def nextHoldDeadline(holds: HoldId -> Hold): int =
    openHolds(holds).fold(NO_DEADLINE, (acc, id) =>
      if (holds.get(id).expiresAt < acc) holds.get(id).expiresAt else acc)

  // The next thing the clock has to stop for: a hold's deadline or the period
  // boundary, whichever comes first. A standing that no longer rolls has no
  // boundary to wait for.
  pure def nextDeadline(s: State): int = {
    val boundary = if (rollsPeriod(s.status)) s.periodEnd else NO_DEADLINE
    val hold = nextHoldDeadline(s.holds)
    if (hold < boundary) hold else boundary
  }

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
          spent: s.spent + cost,
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
      spent: if (creditPriced) s.spent + spent else s.spent,
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
    periodEnd: s.now + PERIOD_LENGTH,
    remaining: FEATURES.mapBy(feature =>
      if (isCreditPriced(allowanceOf(feature))) 0 else allowanceOf(feature).included),
    used: FEATURES.mapBy(feature => 0),
    carried: FEATURES.mapBy(feature => 0),
    credits: CREDITS_GRANTED,
    spent: 0,
    consumed: 0,
    expired: 0,
  }

  // ── the period boundary ────────────────────────────────────────────────────

  // A close is the boundary and nothing more: it needs the period to be over,
  // and a terminal standing has no period to close.
  pure def canClosePeriod(s: State): bool =
    rollsPeriod(s.status) and s.now >= s.periodEnd

  // What one allowance's next period starts with. `resetOf` in
  // Subscription.state.ts: a kept feature is left alone, a feature that carries
  // rolls over what it did not spend — clamped to `[0, cap]`, so a period never
  // holds two periods' worth and an overdrawn allowance never charges the next
  // one — and everything else starts at what the tier includes.
  pure def closeCarry(allowance: Allowance, remaining: int): int =
    clamp(remaining, 0, carriedCapOf(allowance))

  pure def closeRemaining(allowance: Allowance, remaining: int): int =
    if (isKeptOnClose(allowance) or isCreditPriced(allowance))
      remaining
    else allowance.included + closeCarry(allowance, remaining)

  // `ClosePeriod`: a scheduled tier change would land first (out of scope), then
  // every open hold of a feature the boundary resets is released, then the
  // counters reset and the contract's own credits expire. A hold the boundary
  // drops is removed rather than closed: the id is available again, because a
  // replay of the closing period reproduces the same removal.
  pure def applyClosePeriod(s: State): State = {
    val dropped = HOLDS.filter(id =>
      s.holds.get(id).status == Open
        and not(isKeptOnClose(s.allowances.get(s.holds.get(id).feature))))
    {
      ...s,
      periodEnd: s.periodEnd + PERIOD_LENGTH,
      remaining: FEATURES.fold(s.remaining, (acc, feature) =>
        acc.set(feature, closeRemaining(s.allowances.get(feature), s.remaining.get(feature)))),
      carried: FEATURES.fold(s.carried, (acc, feature) =>
        acc.set(feature, closeCarry(s.allowances.get(feature), s.remaining.get(feature)))),
      used: FEATURES.fold(s.used, (acc, feature) =>
        if (isKeptOnClose(s.allowances.get(feature))) acc else acc.set(feature, 0)),
      holds: HOLDS.fold(s.holds, (acc, id) =>
        if (dropped.contains(id)) acc.set(id, { ...s.holds.get(id), status: Available }) else acc),
      // `creditsExpire: "period"` for every standing in the model; the plan's
      // grant ends with the period it was sold for.
      credits: 0,
      expired: s.expired + s.credits,
    }
  }

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // What a period conserves: every unit the period started with — what the tier
  // includes, plus what the boundary carried in — is accounted for as
  // remaining, used, or held. This is the one that catches a release that
  // forgets to return, a settle that returns twice, a hold that writes
  // `remaining` without taking anything, and a close that keeps a counter or a
  // debt it should have dropped.
  val countedConserved: bool =
    FEATURES.filter(f => not(isCreditPriced(state.allowances.get(f)))).forall(f =>
      state.remaining.get(f) + state.used.get(f) + reservedUnits(state.holds, f)
        == state.allowances.get(f).included + state.carried.get(f))

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

  // A boundary carries at most what it is allowed to, and nothing at all for a
  // feature that does not roll over: an overdrawn allowance never charges the
  // next period, and a period never starts with two periods' worth.
  val carriedIsBounded: bool =
    FEATURES.forall(f =>
      state.carried.get(f) >= 0
        and state.carried.get(f) <= carriedCapOf(state.allowances.get(f)))

  // The pool covers every open hold: settle has credits to bill, so the pool
  // never needs a negative balance to explain a reservation. A boundary
  // releases a credit hold before it expires the grant, which is why this holds
  // across a close.
  val creditsCoverEveryHold: bool =
    state.credits >= reservedCredits(state.holds)

  // The pool is a fold of the log, one balance for every credit-priced feature:
  // what a feature spent, what a command consumed outright, what a boundary
  // expired, and what is left is exactly what activation granted. Gated on
  // activation because an unsubscribed standing holds no pool.
  val creditPoolConserved: bool =
    state.status == Unsubscribed or (
      state.credits + state.spent + state.consumed + state.expired == CREDITS_GRANTED)

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

  // The same for the period: the clock stops at the boundary, so a period that
  // is still open is never past its end. A close is the only way forward.
  val noPeriodPastEnd: bool =
    not(rollsPeriod(state.status)) or state.now <= state.periodEnd

  val paykitInvariant: bool = and {
    countedConserved,
    noNegativeUsage,
    blockingNeverOversubscribed,
    carriedIsBounded,
    creditsCoverEveryHold,
    creditPoolConserved,
    holdCostIsAmountTimesRate,
    noHoldPastDeadline,
    noPeriodPastEnd,
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

  // `PeriodEnded` is the schedulable form of `ClosePeriod`: before the boundary
  // it records nothing, which is the same state as being disabled here.
  action closePeriod: bool = all {
    canClosePeriod(state),
    state' = applyClosePeriod(state),
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

  // Time. The clock stops at the next deadline — a hold's, or the period's —
  // instead of passing it, so nothing is ever overdue. This is the model's one
  // scheduling assumption, and `noHoldPastDeadline` and `noPeriodPastEnd` are
  // its statement.
  action tick: bool = all {
    state.now + 1 <= nextDeadline(state),
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
      closePeriod,
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
      periodEnd: PERIOD_LENGTH,
      allowances: FEATURES.mapBy(feature => allowanceOf(feature)),
      remaining: FEATURES.mapBy(feature =>
        if (isCreditPriced(allowanceOf(feature))) 0 else allowanceOf(feature).included),
      used: FEATURES.mapBy(feature => 0),
      carried: FEATURES.mapBy(feature => 0),
      credits: 0,
      spent: 0,
      consumed: 0,
      expired: 0,
      holds: EMPTY_HOLDS,
    },
  }

  // ── witnesses ──────────────────────────────────────────────────────────────

  // A witness names a state and asks whether it is reachable. `0%` means the
  // action behind it is dead, so fix that before trusting the invariant above.

  val messagesUsed: bool = state.used.get("messages") > 0

  val requestsBilledPastIncluded: bool = state.used.get("requests") > REQUESTS_INCLUDED

  val creditsSpentByUsage: bool = state.spent > 0

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

  // The boundary itself: a period rolled, a remainder carried, the plan's
  // credits gone, and a `resets: "never"` counter that outlived all of it.
  val periodRolled: bool = state.periodEnd > PERIOD_LENGTH

  val carriedForward: bool = state.carried.get("messages") > 0

  val creditsExpiredAtBoundary: bool = state.expired > 0

  val keptCounterSurvivesClose: bool =
    state.used.get("storage") > 0 and state.periodEnd > PERIOD_LENGTH
}
