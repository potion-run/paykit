// A Quint model of the *boundary* protocol: reset windows that the period does
// not own, a quantity that is set rather than spent, a top-up cooldown, and the
// retry rungs a failed refill schedules.
//
// This is the fourth protocol of the billing model. `paykit.qnt` models the
// period's own counters; this models the other clocks and the count that is
// bought. The invariants that matter are that a window always advances, that a
// quantity never exceeds its cap, and that a rung belongs to the episode that
// scheduled it.
//
// Source correspondence:
//   track              ↔ TrackUsage.command.ts         (the count effect only)
//   resetWindow        ↔ ResetAllowance.command.ts     (AllowanceReset)
//   closePeriod        ↔ ClosePeriod.command.ts        (UsageReset, kept features)
//   setQuantity        ↔ SetQuantity.command.ts        (QuantityChanged)
//   changeTierCap      ↔ ChangeTier.command.ts         (the quantity branch)
//   spendCredits       ↔ ConsumeCredits.command.ts     (the pool effect only)
//   failTopUp          ↔ RecordTopUpFailure.command.ts + AutoTopUp.policy.ts
//   fireRung           ↔ RetryTopUp.command.ts         (TopUpRetryDue)
//   buyTopUp           ↔ PurchaseCredits.command.ts    (CreditsPurchased)
//   cooldownElapsed    ↔ TopUpCooldownElapsed.command.ts
//   endStanding        ↔ Expire.command.ts / GraceElapsed.command.ts
//   tick               ↔ the platform clock
//
// Scope and the code divergences this model names are in README.md beside this
// file. The hold deadline and the period's carry arithmetic are paykit.qnt's
// job; this model only says what a window does when it is not the period's.
module windows {

  // ── types ──────────────────────────────────────────────────────────────────

  type WindowFeature = Messages | Requests
  type Phase = Open | Ended

  // One allowance window. `periodOwned` is true for a monthly allowance, whose
  // boundary is the standing's period; false for a daily or quarterly one,
  // whose boundary is its own. `blocking` says whether the count may go below
  // zero (a `block` allowance only).
  type Window = {
    remaining: int,
    included: int,
    boundary: int,
    every: int,
    carryCap: int,
    periodOwned: bool,
    blocking: bool,
    lastResetAt: int,
  }

  // A non-consumable feature has two counts. `purchased` is what the customer
  // bought, including the free grant; `occupied` is what is in use. The balance
  // is `purchased - occupied` and may be negative, because a purchase change
  // never removes an occupied seat. `cap` is the most that may be purchased.
  type Seats = {
    purchased: int,
    occupied: int,
    included: int,
    cap: int,
  }

  // The auto top-up cooldown: none, or the deadline a purchase opened.
  type CooldownState = NoCooldown | Cooldown({ until: int })

  // One scheduled retry. The episode is the identity of the failure run; the
  // attempt is the count within it. A rung is live only for both.
  type Rung = {
    episode: int,
    attempt: int,
    at: int,
  }

  type State = {
    phase: Phase,
    now: int,
    endedAt: int,
    periodEnd: int,
    windows: WindowFeature -> Window,
    seats: Seats,
    credits: int,
    cooldown: CooldownState,
    topUpAttempts: int,
    topUpEpisode: int,
    rungs: Set[Rung],
    firedRungs: int,
    cooldownsCleared: int,
    lastFiredAt: int,
    resets: int,
  }

  // ── the catalogue and the clock ────────────────────────────────────────────

  pure val WINDOW_FEATURES: Set[WindowFeature] = Set(Messages, Requests)

  pure val PERIOD_LENGTH: int = 5
  pure val TOP_UP_THRESHOLD: int = 4
  pure val TOP_UP_PACK: int = 10
  pure val TOP_UP_BUDGET: int = 2
  pure val TOP_UP_EVERY: int = 2
  pure val COOLDOWN_LENGTH: int = 3
  pure val MAX_TIME: int = 30

  pure val INITIAL_WINDOWS: WindowFeature -> Window = Map(
    Messages -> {
      remaining: 10,
      included: 10,
      boundary: 1,
      every: 1,
      carryCap: 4,
      periodOwned: false,
      blocking: true,
      lastResetAt: 0,
    },
    Requests -> {
      remaining: 2,
      included: 2,
      boundary: PERIOD_LENGTH,
      every: PERIOD_LENGTH,
      carryCap: 0,
      periodOwned: true,
      blocking: false,
      lastResetAt: 0,
    },
  )

  // ── the windows ────────────────────────────────────────────────────────────

  pure def carryOf(window: Window): int =
    if (window.carryCap <= 0)
      0
    else if (window.remaining < 0)
      0
    else if (window.remaining > window.carryCap)
      window.carryCap
    else window.remaining

  pure def resetWindowTo(window: Window, at: int): Window = {
    ...window,
    remaining: window.included + carryOf(window),
    boundary: at + window.every,
    lastResetAt: at,
  }

  // A window the period does not own is reset only by its own boundary. A
  // period-owned window is reset by the close instead, so `resetWindow` is
  // disabled for it.
  pure def canResetWindow(window: Window, at: int, now: int): bool =
    not(window.periodOwned)
      and window.every > 0
      and at == window.boundary
      and now >= at

  // A close resets every period-owned window at the boundary. An independent
  // window is left exactly where it was.
  pure def closeWindow(window: Window, at: int): Window =
    if (window.periodOwned) resetWindowTo(window, at) else window

  pure def closedWindows(windows: WindowFeature -> Window, at: int): WindowFeature -> Window =
    WINDOW_FEATURES.fold(windows, (acc, feature) =>
      acc.set(feature, closeWindow(windows.get(feature), at)))

  pure def windowResets(windows: WindowFeature -> Window, at: int): int =
    WINDOW_FEATURES.fold(0, (acc, feature) =>
      if (windows.get(feature).periodOwned) acc + 1 else acc)

  // ── the quantity ───────────────────────────────────────────────────────────

  pure def canSetQuantity(seats: Seats, quantity: int): bool =
    quantity >= 0 and quantity <= seats.cap

  // A purchase change is set to a total; occupancy is set separately. Setting
  // the purchase below occupancy is allowed and leaves a negative balance.
  pure def seatBalance(seats: Seats): int = seats.purchased - seats.occupied

  pure def canCheckSeats(seats: Seats, required: int): bool =
    required >= 0 and seatBalance(seats) >= required

  // A tier change keeps the purchased quantity, or raises it to the new free
  // grant. It does not refuse a move because the new cap is below what the
  // account already bought: taking seats away is not a side effect of a plan
  // change. The account is over its purchase cap until it buys down.
  pure def canChangeTier(seats: Seats, cap: int, included: int): bool =
    cap >= 0 and included >= 0 and included <= cap

  pure def changedTier(seats: Seats, cap: int, included: int): Seats = {
    ...seats,
    cap: cap,
    included: included,
    purchased: if (seats.purchased > included) seats.purchased else included,
  }

  // ── the cooldown ───────────────────────────────────────────────────────────

  pure def cooldownUntil(cooldown: CooldownState): int =
    match cooldown {
      | NoCooldown => 0
      | Cooldown(value) => value.until
    }

  pure def hasCooldown(cooldown: CooldownState): bool =
    match cooldown {
      | NoCooldown => false
      | Cooldown(_) => true
    }

  // ── the retry rungs ────────────────────────────────────────────────────────

  pure def liveRung(state: State, rung: Rung): bool =
    state.rungs.contains(rung)
      and rung.episode == state.topUpEpisode
      and rung.attempt == state.topUpAttempts
      and state.now >= rung.at

  // A rung fires only for the episode and attempt it names, while the pool is
  // still under the line and no cooldown is open. A success or a newer failure
  // makes every rung from the old episode stale (ADR 0031).
  pure def canFireRung(state: State, rung: Rung): bool =
    state.phase == Open
      and liveRung(state, rung)
      and not(hasCooldown(state.cooldown))
      and state.credits <= TOP_UP_THRESHOLD

  // A failure clears the rungs of the episode it ends, then schedules the one
  // rung the new attempt is owed. Keeping the queue clean is the second half of
  // the identity rule: a stale rung is not merely refused, it is not there.
  pure def failedTopUp(state: State): State = {
    val nextAttempt = state.topUpAttempts + 1
    val nextEpisode = if (state.topUpAttempts == 0) state.topUpEpisode + 1 else state.topUpEpisode

    {
      ...state,
      topUpAttempts: nextAttempt,
      topUpEpisode: nextEpisode,
      rungs:
        if (nextAttempt <= TOP_UP_BUDGET)
          Set({ episode: nextEpisode, attempt: nextAttempt, at: state.now + TOP_UP_EVERY })
        else Set(),
    }
  }

  // A purchase is the refill that was owed: it clears the queue, resets the
  // budget, and opens the cooldown the deployment asked for.
  pure def boughtTopUp(state: State): State = {
    ...state,
    credits: state.credits + TOP_UP_PACK,
    topUpAttempts: 0,
    rungs: Set(),
    cooldown: Cooldown({ until: state.now + COOLDOWN_LENGTH }),
  }

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // Both counts are non-negative. The balance may be negative, and a purchase
  // may remain above a new plan's cap; only `setQuantity` is capped.
  val seatCountsNonNegative: bool =
    state.seats.purchased >= 0 and state.seats.occupied >= 0

  val seatCheckAgreesWithBalance: bool =
    canCheckSeats(state.seats, 1) == (seatBalance(state.seats) >= 1)

  val seatBalanceIsDerived: bool =
    seatBalance(state.seats) == state.seats.purchased - state.seats.occupied

  // A blocking count spends down, never below zero, and a reset never adds more
  // than the carry cap allows. The billing count (Requests) may go below zero,
  // because that is what overage means; only the blocking windows are asserted.
  val blockingCountsBounded: bool =
    WINDOW_FEATURES.forall(feature => {
      val window = state.windows.get(feature)

      not(window.blocking)
        or (window.remaining >= 0 and window.remaining <= window.included + window.carryCap)
    })

  // Every window's next boundary is exactly one interval after the boundary it
  // last closed. A reset therefore moves the chain forward, never backwards.
  val boundariesAdvance: bool =
    WINDOW_FEATURES.forall(feature => {
      val window = state.windows.get(feature)

      window.every > 0
        and window.boundary == window.lastResetAt + window.every
        and window.boundary > window.lastResetAt
    })

  // A rung in the queue is always live for the current episode and attempt, and
  // inside the budget. The queue never carries a rung from an ended episode.
  val rungsBelongToTheBudget: bool =
    state.rungs.forall(rung =>
      rung.episode == state.topUpEpisode
        and rung.attempt == state.topUpAttempts
        and rung.attempt > 0
        and rung.attempt <= TOP_UP_BUDGET)

  val topUpAttemptsWithinBudget: bool = state.topUpAttempts <= TOP_UP_BUDGET + 1

  // An ended standing has no boundary left to reset, and a rung cannot fire
  // after the end. The end is the last instant either clock may act.
  val noWindowResetAfterEnd: bool =
    state.endedAt == 0
      or WINDOW_FEATURES.forall(feature => state.windows.get(feature).lastResetAt <= state.endedAt)

  val noRungFiredAfterEnd: bool =
    state.endedAt == 0 or state.lastFiredAt <= state.endedAt

  val cooldownHasADeadline: bool =
    not(hasCooldown(state.cooldown)) or cooldownUntil(state.cooldown) > 0

  val creditsNeverNegative: bool = state.credits >= 0

  val windowsInvariant: bool = and {
    seatCountsNonNegative,
    seatCheckAgreesWithBalance,
    seatBalanceIsDerived,
    blockingCountsBounded,
    boundariesAdvance,
    rungsBelongToTheBudget,
    topUpAttemptsWithinBudget,
    noWindowResetAfterEnd,
    noRungFiredAfterEnd,
    cooldownHasADeadline,
    creditsNeverNegative,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  action track(feature: WindowFeature, amount: int): bool = {
    val window = state.windows.get(feature)
    all {
      state.phase == Open,
      amount > 0,
      not(window.blocking) or amount <= window.remaining,
      state' = {
        ...state,
        windows: state.windows.set(feature, {
          ...window,
          remaining: window.remaining - amount,
        }),
      },
    }
  }

  // Close the window the allowance recorded, and only that one. A fire before
  // the boundary, or for a boundary a later tier change replaced, is disabled.
  action resetWindow(feature: WindowFeature, at: int): bool = all {
    state.phase == Open,
    canResetWindow(state.windows.get(feature), at, state.now),
    state' = {
      ...state,
      windows: state.windows.set(feature, resetWindowTo(state.windows.get(feature), at)),
      resets: state.resets + 1,
    },
  }

  // The period's own close. It resets the monthly windows and leaves every
  // window the period does not own exactly where it was; a seat is not a
  // counter, so it survives either way.
  action closePeriod: bool = all {
    state.phase == Open,
    state.now >= state.periodEnd,
    state' = {
      ...state,
      periodEnd: state.periodEnd + PERIOD_LENGTH,
      windows: closedWindows(state.windows, state.periodEnd),
      resets: state.resets + windowResets(state.windows, state.periodEnd),
    },
  }

  action setQuantity(quantity: int): bool = all {
    state.phase == Open,
    canSetQuantity(state.seats, quantity),
    state' = { ...state, seats: { ...state.seats, purchased: quantity } },
  }

  // Occupancy is a separate write. It may exceed the purchased quantity; the
  // balance then blocks new occupancy while existing seats keep working.
  action setUsage(usage: int): bool = all {
    state.phase == Open,
    usage >= 0,
    state' = { ...state, seats: { ...state.seats, occupied: usage } },
  }

  // A tier change can raise the quantity to the new free grant, but it cannot
  // leave it above the new cap. The code's `ChangeTier` has no quantity branch;
  // this action models the rule the quantity needs.
  action changeTierCap(cap: int, included: int): bool = all {
    state.phase == Open,
    canChangeTier(state.seats, cap, included),
    state' = { ...state, seats: changedTier(state.seats, cap, included) },
  }

  action spendCredits(amount: int): bool = all {
    state.phase == Open,
    amount > 0,
    amount <= state.credits,
    state' = { ...state, credits: state.credits - amount },
  }

  action failTopUp: bool = all {
    state.phase == Open,
    state.topUpAttempts <= TOP_UP_BUDGET,
    state' = failedTopUp(state),
  }

  action fireRung(rung: Rung): bool = all {
    canFireRung(state, rung),
    state' = {
      ...state,
      rungs: state.rungs.exclude(Set(rung)),
      firedRungs: state.firedRungs + 1,
      lastFiredAt: state.now,
    },
  }

  // Fire the one rung the queue holds, if it is live. This is the policy's
  // scheduler choosing the rung, not a caller inventing one.
  action fireAnyRung: bool = {
    nondet rung = state.rungs.oneOf()
    all {
      state.rungs.size() > 0,
      canFireRung(state, rung),
      state' = {
        ...state,
        rungs: state.rungs.exclude(Set(rung)),
        firedRungs: state.firedRungs + 1,
        lastFiredAt: state.now,
      },
    }
  }

  action buyTopUp: bool = all {
    state.phase == Open,
    state' = boughtTopUp(state),
  }

  action cooldownElapsed: bool = all {
    hasCooldown(state.cooldown),
    state.now >= cooldownUntil(state.cooldown),
    state' = {
      ...state,
      cooldown: NoCooldown,
      cooldownsCleared: state.cooldownsCleared + 1,
    },
  }

  action endStanding: bool = all {
    state.phase == Open,
    state' = { ...state, phase: Ended, endedAt: state.now },
  }

  action tick: bool = all {
    state.now < MAX_TIME,
    state' = { ...state, now: state.now + 1 },
  }

  action step: bool = {
    nondet feature = WINDOW_FEATURES.oneOf()
    nondet amount = 1.to(20).oneOf()
    nondet at = 0.to(30).oneOf()
    nondet cap = 0.to(20).oneOf()
    nondet included = 0.to(10).oneOf()
    nondet episode = 0.to(4).oneOf()
    nondet attempt = 0.to(4).oneOf()
    nondet rungAt = 0.to(30).oneOf()
    any {
      track(feature, amount),
      resetWindow(feature, at),
      closePeriod,
      setQuantity(amount),
      setUsage(amount),
      changeTierCap(cap, included),
      spendCredits(amount),
      failTopUp,
      fireRung({ episode: episode, attempt: attempt, at: rungAt }),
      fireAnyRung,
      buyTopUp,
      cooldownElapsed,
      endStanding,
      tick,
    }
  }

  action init: bool = all {
    state' = {
      phase: Open,
      now: 0,
      endedAt: 0,
      periodEnd: PERIOD_LENGTH,
      windows: INITIAL_WINDOWS,
      seats: { purchased: 2, occupied: 0, included: 2, cap: 10 },
      credits: 20,
      cooldown: NoCooldown,
      topUpAttempts: 0,
      topUpEpisode: 0,
      rungs: Set(),
      firedRungs: 0,
      cooldownsCleared: 0,
      lastFiredAt: 0,
      resets: 0,
    },
  }

  // ── witnesses ─────────────────────────────────────────────────────────────

  val dailyWindowReset: bool = state.windows.get(Messages).lastResetAt > 0

  val periodWindowReset: bool = state.windows.get(Requests).lastResetAt > 0

  val lateReset: bool =
    state.resets > 0
      and WINDOW_FEATURES.exists(feature => {
        val window = state.windows.get(feature)
        window.lastResetAt > 0 and state.now > window.lastResetAt
      })

  val quantitySet: bool = state.seats.purchased != 2

  val usageSet: bool = state.seats.occupied > 0

  val seatBalanceNegative: bool = seatBalance(state.seats) < 0

  val quantityRaisedByTier: bool =
    state.seats.purchased == state.seats.included and state.seats.included > 2

  val topUpFailed: bool = state.topUpAttempts > 0

  val rungScheduled: bool = state.rungs.size() > 0

  val rungFired: bool = state.firedRungs > 0

  val cooldownOpened: bool = hasCooldown(state.cooldown)

  val cooldownCleared: bool = state.cooldownsCleared > 0

  val ended: bool = state.phase == Ended

  // A seat survived a period close: the close happened and the quantity is not
  // the grant it started at.
  val seatSurvivedClose: bool = state.periodEnd > PERIOD_LENGTH and state.seats.purchased != 2
}
