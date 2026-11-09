// A Quint model of customer controls: a money ceiling on one feature, and the
// usage alert that records a crossing without refusing anything.
//
// This is the seventh protocol. `paykit.qnt` is the spend path, `standing.qnt`
// the phase machine, `windows.qnt` the clocks the period does not own,
// `plans.qnt` the plan operations, `balances.qnt` the sources behind one count,
// and `money.qnt` the money facts. Customer controls are the first protocol
// where the customer, not the catalog, states a rule.
//
// Source correspondence:
//   setControls, clearControls  ↔ SetBillingControls.command.ts
//   track                       ↔ TrackUsage.command.ts (a hold's admission too)
//   refuse                      ↔ the refused branch of TrackUsage / Hold
//   fireAlert                   ↔ UsageAlertFired, recorded with the usage fact
//   closePeriod                 ↔ ClosePeriod.command.ts (PeriodClosed)
//   tick                        ↔ the platform clock
//
// The auto top-up override is deliberately not here. It is a pure read — the
// customer's line when present, otherwise the standing plan's — and a pure
// function is a unit test, not a protocol. This model is the state that can
// refuse a spend or record a crossing, and nothing else.
//
// Scope and the code divergences are in README.md beside this file. The
// arithmetic of a price is `paykit.qnt`'s job; this model says when the ceiling
// refuses and when an alert is allowed to fire.
module controls {

  // ── types ──────────────────────────────────────────────────────────────────

  type Standing = Good | Blocked

  type State = {
    now: int,
    periodEnd: int,
    standing: Standing,
    // The customer's ceiling in minor units. `hasLimit` is separate because a
    // ceiling of zero is a real control (bill nothing), not the absence of one.
    hasLimit: bool,
    limit: int,
    // Whether `setControls` put the ceiling under money already billed. A
    // ceiling stops new spend; it never unbills history.
    loweredBelowBill: bool,
    // What this period has billed and used.
    billed: int,
    used: int,
    // The one alert threshold this feature states, and the evidence it fired.
    fired: bool,
    alertFires: int,
    // History, so a refusal and a close are checkable rather than asserted on
    // the current numbers alone.
    refusals: int,
    writes: int,
    writesSinceClose: int,
    closes: int,
    // The ceiling as it was when the last close ran. A close that clears it
    // must not also clear this, or the loss is invisible.
    hadLimitAtClose: bool,
    limitAtClose: int,
  }

  pure val PERIOD_LENGTH: int = 5
  pure val MAX_TIME: int = 20
  pure val PRICE: int = 2
  pure val ALERT_AT: int = 5

  pure def chargeOf(units: int): int = units * PRICE

  // A track passes when there is no ceiling, or when what it would bill still
  // fits. The ceiling is money and this period's billed total is the count it
  // bounds; the standing is not part of this rule.
  pure def allowsTrack(s: State, units: int): bool =
    not(s.hasLimit) or s.billed + chargeOf(units) <= s.limit

  pure def applyTrack(s: State, units: int): State = {
    ...s,
    billed: s.billed + chargeOf(units),
    used: s.used + units,
  }

  // A refusal records its evidence and moves nothing — not the bill, and not
  // the standing.
  pure def applyRefuse(s: State, units: int): State = {
    ...s,
    refusals: s.refusals + 1,
  }

  // A close resets the period's counters and the alert latch. The ceiling is
  // the customer's, not the period's, so it is untouched: the close records it
  // first, and `hadLimitAtClose` is what makes a clearing close visible.
  pure def applyClose(s: State): State = {
    ...s,
    billed: 0,
    used: 0,
    fired: false,
    alertFires: 0,
    loweredBelowBill: false,
    closes: s.closes + 1,
    hadLimitAtClose: s.hasLimit,
    limitAtClose: s.limit,
    writesSinceClose: 0,
    now: s.periodEnd,
    periodEnd: s.periodEnd + PERIOD_LENGTH,
  }

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // The ceiling is a ceiling: a period's billed money never passes it, unless
  // the customer lowered the ceiling under money already billed. A ceiling
  // stops new spend; it never unbills history.
  val limitIsACeiling: bool =
    not(state.hasLimit) or state.billed <= state.limit or state.loweredBelowBill

  // One alert threshold fires once a period: the evidence count and the latch
  // cannot disagree.
  val alertFiresOncePerPeriod: bool =
    state.alertFires == (if (state.fired) 1 else 0)

  // An alert is evidence: it fires only at or past its threshold.
  val alertOnlyAtOrPastItsThreshold: bool =
    not(state.fired) or state.used >= ALERT_AT

  // A close leaves the ceiling alone until the customer writes again.
  val limitSurvivesAClose: bool =
    state.closes == 0 or
    state.writesSinceClose > 0 or
    (state.hasLimit == state.hadLimitAtClose and state.limit == state.limitAtClose)

  // A close never leaves the clock past the boundary it owns.
  val noTrackPastPeriod: bool = state.now <= state.periodEnd

  val controlsInvariant: bool = and {
    limitIsACeiling,
    alertFiresOncePerPeriod,
    alertOnlyAtOrPastItsThreshold,
    limitSurvivesAClose,
    noTrackPastPeriod,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  action setControls(value: int): bool = all {
    value >= 0,
    state' = {
      ...state,
      hasLimit: true,
      limit: value,
      loweredBelowBill: value < state.billed,
      writes: state.writes + 1,
      writesSinceClose: state.writesSinceClose + 1,
    },
  }

  action clearControls: bool = all {
    state' = {
      ...state,
      hasLimit: false,
      writes: state.writes + 1,
      writesSinceClose: state.writesSinceClose + 1,
    },
  }

  // The accepted branch. `refuse` is the other branch of the same command, so a
  // `run` can prove the accept-set with `track(100).fail()` and the refusal
  // with `refuse(100)`.
  action track(units: int): bool = all {
    units > 0,
    state.standing == Good,
    state.now <= state.periodEnd,
    allowsTrack(state, units),
    state' = applyTrack(state, units),
  }

  action refuse(units: int): bool = all {
    units > 0,
    state.standing == Good,
    state.now <= state.periodEnd,
    not(allowsTrack(state, units)),
    state' = applyRefuse(state, units),
  }

  action fireAlert: bool = all {
    state.used >= ALERT_AT,
    not(state.fired),
    state' = {
      ...state,
      fired: true,
      alertFires: state.alertFires + 1,
    },
  }

  action closePeriod: bool = all {
    state.now >= state.periodEnd,
    state' = applyClose(state),
  }

  action block: bool = all {
    state' = { ...state, standing: Blocked },
  }

  action unblock: bool = all {
    state' = { ...state, standing: Good },
  }

  action tick: bool = all {
    state.now + 1 <= state.periodEnd,
    state.now < MAX_TIME,
    state' = { ...state, now: state.now + 1 },
  }

  action step: bool = {
    nondet units = 1.to(8).oneOf()
    nondet limit = 0.to(12).oneOf()
    any {
      setControls(limit),
      clearControls,
      track(units),
      refuse(units),
      fireAlert,
      closePeriod,
      block,
      unblock,
      tick,
    }
  }

  action init: bool = all {
    state' = {
      now: 0,
      periodEnd: PERIOD_LENGTH,
      standing: Good,
      hasLimit: false,
      limit: 0,
      loweredBelowBill: false,
      billed: 0,
      used: 0,
      fired: false,
      alertFires: 0,
      refusals: 0,
      writes: 0,
      writesSinceClose: 0,
      closes: 0,
      hadLimitAtClose: false,
      limitAtClose: 0,
    },
  }

  // ── witnesses ──────────────────────────────────────────────────────────────

  val limitSet: bool = state.writes > 0 and state.hasLimit

  val limitCleared: bool = state.writes > 0 and not(state.hasLimit)

  val billedUsage: bool = state.billed > 0

  val refused: bool = state.refusals > 0

  val alertFired: bool = state.fired

  val closed: bool = state.closes > 0

  val limitSurvivedClose: bool =
    state.closes > 0 and state.hadLimitAtClose and state.hasLimit
}
