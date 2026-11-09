// A Quint model of the Subscription standing's *lifecycle*: how an account
// moves between unsubscribed, trialing, active, grace, expired and canceled,
// what a scheduled cancellation and a scheduled tier change do at the period
// boundary, and which run a dunning rung or an auto top-up retry belongs to.
//
// This is the second protocol of the billing model. `paykit.qnt` models the
// spend path; this models the phase machine that decides *when* a spend is
// allowed and what a boundary means. The two share vocabulary but not state:
// keep a lifecycle rule here and a counter rule there.
//
// Source correspondence:
//   startTrial          ↔ StartTrial.command.ts         (TrialStarted)
//   subscribe           ↔ Subscribe.command.ts          (SubscriptionActivated)
//   extendTrial         ↔ ExtendTrial.command.ts        (TrialExtended)
//   enterGrace          ↔ EnterGrace.command.ts         (GraceEntered)
//   failPayment         ↔ RecordPaymentFailure.command.ts (PaymentFailed)
//   recordPayment       ↔ RecordPayment.command.ts      (PaymentRecorded)
//   recover             ↔ Recover.command.ts            (Recovered)
//   graceElapsed        ↔ GraceElapsed.command.ts       (SubscriptionExpired)
//   expire              ↔ Expire.command.ts             (SubscriptionExpired)
//   scheduleCancellation↔ ScheduleCancellation.command.ts (CancellationScheduled)
//   resume              ↔ Resume.command.ts             (CancellationWithdrawn)
//   scheduleTier        ↔ ScheduleTierChange.command.ts (TierChangeScheduled)
//   withdrawTier        ↔ WithdrawTierChange.command.ts (TierChangeWithdrawn)
//   changeTier          ↔ ChangeTier.command.ts         (TierChanged)
//   closePeriod         ↔ ClosePeriod.command.ts + PeriodEnded.command.ts
//                                                       (TierChanged, PeriodClosed)
//   dunningRung         ↔ DunningRetry.command.ts       (DunningRetryDue)
//   failTopUp           ↔ RecordTopUpFailure.command.ts (TopUpFailed)
//   buyTopUp            ↔ PurchaseCredits.command.ts    (CreditsPurchased)
//   topUpRung           ↔ RetryTopUp.command.ts         (TopUpRetryDue)
//   tick                ↔ the platform clock the policies schedule against
//
// Scope, the source-file map, and the known gaps are in README.md beside this
// file. The standing's *money* (refunds, proration invoices) is money.qnt; its
// *windows* (holds, resets, cooldowns) are windows.qnt.
module standing {

  // ── types ──────────────────────────────────────────────────────────────────

  // `Unsubscribed` is `initial`; `Expired` and `Canceled` are the two terminal
  // phases a later activation may replace (ADR 0020).
  type Phase = Unsubscribed | Trialing | Active | Grace | Expired | Canceled

  // The catalogue is three plan shapes: a free plan, a paid plan, and a larger
  // paid plan. Every plan's credits belong to the period; a lifetime grant is
  // a separate source and is not a plan setting (ADR 0037).
  type Tier = Free | Pro | Scale

  // A tier change scheduled for the boundary, or none. A sum type rather than
  // a nullable field, so "no pending tier" is a value and not an absent key.
  type Schedule = NoTier | Pending(Tier)

  type State = {
    phase: Phase,
    tier: Tier,
    now: int,
    // The end of the open period. A close moves it by `PERIOD_LENGTH`.
    periodEnd: int,
    // The lifetime trial latch: once true, `startTrial` can never run again.
    trialUsed: bool,
    // A cancellation recorded for the boundary. A close carries it into
    // `canceled`, where `resume` may still clear it (ADR 0020).
    cancelAtPeriodEnd: bool,
    // The change the boundary applies, if one was scheduled.
    pending: Schedule,
    // The dunning deadline, or `NO_DEADLINE` when the phase is not grace.
    graceEnd: int,
    // The identity of the current dunning run. A rung from a run that a
    // recovery or a new failure ended is stale and must not charge.
    dunningRun: int,
    dunningAttempts: int,
    // Auto top-up failures in the current episode, and the episode identity a
    // retry rung belongs to (ADR 0031). A success, a new failure, a tier
    // change and a boundary each start a fresh episode.
    topUpAttempts: int,
    topUpEpisode: int,
    // The plan's own pool for the current period. It is replaced or expired
    // at a boundary; it is never carried across a plan change. Its fold is
    // `planCredits + planSpent + planExpired == planGranted`.
    planCredits: int,
    planGranted: int,
    planSpent: int,
    planExpired: int,
    // A lifetime grant belongs to the customer, not the plan. It survives a
    // close, a plan change and a new activation, and it is spent last. Its
    // fold is `lifetimeCredits + lifetimeSpent == lifetimeGranted`.
    lifetimeCredits: int,
    lifetimeGranted: int,
    lifetimeSpent: int,
    // History counters, so a rung that fired is visible to a witness.
    dunningRungs: int,
    topUpRungs: int,
  }

  // ── the catalogue and the clock ────────────────────────────────────────────

  pure val TIERS: Set[Tier] = Set(Free, Pro, Scale)
  pure val PERIOD_LENGTH: int = 5
  pure val NO_DEADLINE: int = 1000000

  // The grant each tier makes for one period. A trial and an activation both
  // grant exactly this.
  pure def grantOf(tier: Tier): int =
    if (tier == Free) 0 else if (tier == Pro) 20 else 8

  pure def isPending(p: Schedule): bool =
    match p {
      | NoTier => false
      | Pending(_) => true
    }

  pure def pendingTierOf(p: Schedule): Tier =
    match p {
      | NoTier => Free
      | Pending(tier) => tier
    }

  // A standing that still has a period to close. Terminal phases do not.
  pure def rollsPeriod(phase: Phase): bool =
    phase == Trialing or phase == Active or phase == Grace

  // A standing that may spend: a free trial, a paying account, and the grace
  // window after a failed payment. Terminal phases may not (ADR 0020).
  pure def allowsUsage(phase: Phase): bool =
    phase == Trialing or phase == Active or phase == Grace

  pure def isTerminal(phase: Phase): bool = phase == Expired or phase == Canceled

  pure def canSubscribe(phase: Phase): bool = phase == Unsubscribed or isTerminal(phase)

  pure def canStartTrial(state: State): bool = not(state.trialUsed)

  pure def canEnterGrace(state: State): bool =
    state.phase == Active or state.phase == Trialing

  pure def canClosePeriod(state: State): bool =
    rollsPeriod(state.phase) and state.now >= state.periodEnd

  pure def clampMax(left: int, right: int): int = if (left > right) left else right

  // The next deadline the clock must stop for: a grace deadline, or the period
  // boundary. A terminal standing has neither, so time is free.
  pure def nextDeadline(state: State): int = {
    val grace = if (state.phase == Grace) state.graceEnd else NO_DEADLINE
    val boundary = if (rollsPeriod(state.phase)) state.periodEnd else NO_DEADLINE

    if (grace < boundary) grace else boundary
  }

  // ── activation ─────────────────────────────────────────────────────────────

  // A fresh standing, in the shape both activation events share. The previous
  // standing's refs and trial latch are the only things carried across a
  // replacement; its counters, credits and schedule are not.
  pure def activated(state: State, tier: Tier, phase: Phase): State = {
    val grant = grantOf(tier)
    {
      ...state,
      phase: phase,
      tier: tier,
      periodEnd: state.now + PERIOD_LENGTH,
      cancelAtPeriodEnd: false,
      pending: NoTier,
      graceEnd: NO_DEADLINE,
      dunningRun: 0,
      dunningAttempts: 0,
      topUpAttempts: 0,
      topUpEpisode: 0,
      planCredits: grant,
      planGranted: grant,
      planSpent: 0,
      planExpired: 0,
      dunningRungs: 0,
      topUpRungs: 0,
    }
  }

  // ── grace, dunning and expiry ──────────────────────────────────────────────

  // A payment failure opens or extends a dunning run. The first failure of a
  // run takes a new identity; later failures keep it, so every rung stays
  // measured from the failure the deployment is actually dunning.
  pure def failedPayment(state: State, graceUntil: int): State = {
    val newRun = state.dunningAttempts == 0
    {
      ...state,
      phase: Grace,
      graceEnd: if (state.graceEnd == NO_DEADLINE) graceUntil else clampMax(state.graceEnd, graceUntil),
      dunningRun: if (newRun) state.dunningRun + 1 else state.dunningRun,
      dunningAttempts: state.dunningAttempts + 1,
    }
  }

  pure def recovered(state: State): State = {
    ...state,
    phase: Active,
    graceEnd: NO_DEADLINE,
    dunningAttempts: 0,
  }

  // A dunning rung is only live for the run and the attempt it was scheduled
  // for, and only inside the grace window. Anything else is a stale rung.
  pure def canDunningRung(state: State, runId: int, afterAttempt: int): bool =
    state.phase == Grace
      and state.dunningRun > 0
      and state.dunningAttempts > 0
      and state.dunningRun == runId
      and state.dunningAttempts == afterAttempt
      and state.now < state.graceEnd

  // ── auto top-up ────────────────────────────────────────────────────────────

  pure val TOP_UP_THRESHOLD: int = 4
  pure val TOP_UP_PACK: int = 10

  // A failure belongs to the episode it started, and increments the budget.
  pure def failedTopUp(state: State): State = {
    val newEpisode = state.topUpAttempts == 0
    {
      ...state,
      topUpAttempts: state.topUpAttempts + 1,
      topUpEpisode: if (newEpisode) state.topUpEpisode + 1 else state.topUpEpisode,
    }
  }

  // A purchase is the refill that was owed: it makes good on the failure and
  // starts the budget over. A pack is a lifetime grant, so it is a separate
  // source and does not become plan credits.
  pure def boughtTopUp(state: State): State = {
    ...state,
    lifetimeCredits: state.lifetimeCredits + TOP_UP_PACK,
    lifetimeGranted: state.lifetimeGranted + TOP_UP_PACK,
    topUpAttempts: 0,
  }

  // A retry rung is live only for the episode and the attempt it names, while
  // the pool is still under the line. A success or a newer episode makes every
  // rung from the old one stale (ADR 0031).
  pure def canTopUpRung(state: State, episode: int, attempt: int): bool =
    allowsUsage(state.phase)
      and state.topUpEpisode == episode
      and state.topUpAttempts == attempt
      and state.planCredits + state.lifetimeCredits <= TOP_UP_THRESHOLD

  // A spend, for the pool's fold and for taking a pool under the top-up
  // line. The spend path itself is paykit.qnt; this is only its credit effect.
  pure def totalCredits(state: State): int =
    state.planCredits + state.lifetimeCredits

  pure def canSpend(state: State, amount: int): bool =
    allowsUsage(state.phase) and amount > 0 and amount <= totalCredits(state)

  // Plan credits are spent before lifetime credits: a lifetime grant is the
  // last money a customer can spend (ADR 0037).
  pure def spend(state: State, amount: int): State = {
    val fromPlan = if (state.planCredits < amount) state.planCredits else amount
    val fromLifetime = amount - fromPlan
    {
      ...state,
      planCredits: state.planCredits - fromPlan,
      planSpent: state.planSpent + fromPlan,
      lifetimeCredits: state.lifetimeCredits - fromLifetime,
      lifetimeSpent: state.lifetimeSpent + fromLifetime,
    }
  }

  // ── the period boundary ────────────────────────────────────────────────────

  // A boundary replaces the plan's source. A scheduled change grants the new
  // plan's credits for the period starting here; a close with no change
  // expires the period's plan credits. Lifetime sources are untouched in both
  // cases (ADR 0037).
  pure def closePlanCredits(state: State, pending: bool): int =
    if (pending) grantOf(pendingTierOf(state.pending)) else 0

  pure def closePlanExpired(state: State): int = state.planCredits

  pure def closePlanGranted(state: State, pending: bool): int =
    state.planGranted + (if (pending) grantOf(pendingTierOf(state.pending)) else 0)

  // The phase a close leaves. A scheduled cancellation wins the boundary; a
  // trial that survives becomes active; grace stays grace until its own
  // deadline expires it.
  pure def closedPhase(state: State): Phase =
    if (state.cancelAtPeriodEnd) Canceled
    else if (state.phase == Trialing) Active
    else state.phase

  // `ClosePeriod`: apply a scheduled tier change, then roll the period and
  // reset the schedule. A terminal standing never reaches this action.
  pure def applyClosePeriod(state: State): State = {
    val pending = isPending(state.pending)
    val nextTier = if (pending) pendingTierOf(state.pending) else state.tier
    {
      ...state,
      phase: closedPhase(state),
      tier: nextTier,
      periodEnd: state.periodEnd + PERIOD_LENGTH,
      pending: NoTier,
      planCredits: closePlanCredits(state, pending),
      planGranted: closePlanGranted(state, pending),
      planExpired: state.planExpired + closePlanExpired(state),
      // A boundary re-establishes the line and the pool, so the refill budget
      // starts over (ADR 0031).
      topUpAttempts: 0,
    }
  }

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // Each source is a fold of its own grant: nothing spends or expires credits
  // that were never granted, and a boundary records what it dropped.
  val planCreditsConserved: bool =
    state.planCredits + state.planSpent + state.planExpired == state.planGranted

  val lifetimeCreditsConserved: bool =
    state.lifetimeCredits + state.lifetimeSpent == state.lifetimeGranted

  val creditPoolConserved: bool = and {
    planCreditsConserved,
    lifetimeCreditsConserved,
  }

  val creditsNeverNegative: bool =
    state.planCredits >= 0 and state.lifetimeCredits >= 0

  // A trial is always a phase the trial latch explains. A subscriber that never
  // took a trial has `trialUsed == false`; a trialing standing has it true.
  val trialingImpliesTrialUsed: bool =
    state.phase != Trialing or state.trialUsed

  // Grace always has a deadline, and the clock never passes it while the
  // standing is still in grace. A grace window with no `graceUntil` is a
  // standing no read can explain.
  val graceHasDeadline: bool =
    state.phase != Grace or state.graceEnd != NO_DEADLINE

  val noGracePastDeadline: bool =
    state.phase != Grace or state.now <= state.graceEnd

  // A close is the only way past a period boundary, so a standing that still
  // rolls is never overdue.
  val noPeriodPastEnd: bool =
    not(rollsPeriod(state.phase)) or state.now <= state.periodEnd

  // Only a standing can have a cancellation recorded, and a terminal standing
  // is the one phase that may still carry the flag a close wrote (ADR 0020).
  val cancellationBelongsToAStanding: bool =
    not(state.cancelAtPeriodEnd) or state.phase != Unsubscribed

  // A dunning rung never fires without a run to belong to, and an attempt
  // count is only meaningful while that run is open.
  val dunningAttemptsHaveARun: bool =
    state.phase != Grace or state.dunningAttempts == 0 or state.dunningRun > 0

  val standingInvariant: bool = and {
    creditPoolConserved,
    creditsNeverNegative,
    trialingImpliesTrialUsed,
    graceHasDeadline,
    noGracePastDeadline,
    noPeriodPastEnd,
    cancellationBelongsToAStanding,
    dunningAttemptsHaveARun,
  }

  // ── actions ────────────────────────────────────────────────────────────────

  // One action per move. A refused command is a disabled action: `quint` does
  // not report rejection tags, so the named tests in standing_test.qnt check
  // the refusals and the accept-set is the model.

  action startTrial(tier: Tier): bool = all {
    canStartTrial(state),
    state' = { ...activated(state, tier, Trialing), trialUsed: true },
  }

  action subscribe(tier: Tier): bool = all {
    canSubscribe(state.phase),
    state' = activated(state, tier, Active),
  }

  action extendTrial(deadline: int): bool = all {
    state.phase == Trialing,
    deadline > state.periodEnd,
    state' = { ...state, periodEnd: deadline },
  }

  action enterGrace(graceUntil: int): bool = all {
    canEnterGrace(state),
    graceUntil > state.now,
    state' = {
      ...state,
      phase: Grace,
      graceEnd: graceUntil,
      dunningAttempts: 0,
    },
  }

  action failPayment(graceUntil: int): bool = all {
    allowsUsage(state.phase),
    graceUntil > state.now,
    state' = failedPayment(state, graceUntil),
  }

  action recordPayment: bool = all {
    state.phase == Grace,
    state' = recovered(state),
  }

  action recover: bool = all {
    state.phase == Grace,
    state' = recovered(state),
  }

  // The scheduled expiry is the hard stop. A fire before the deadline is a
  // no-op in the implementation, which is the same state as disabled here.
  action graceElapsed: bool = all {
    state.phase == Grace,
    state.now >= state.graceEnd,
    state' = { ...state, phase: Expired, graceEnd: NO_DEADLINE },
  }

  action expire: bool = all {
    state.phase == Grace,
    state' = { ...state, phase: Expired, graceEnd: NO_DEADLINE },
  }

  action scheduleCancellation: bool = all {
    rollsPeriod(state.phase),
    not(state.cancelAtPeriodEnd),
    state' = { ...state, cancelAtPeriodEnd: true },
  }

  action resume: bool = all {
    state.phase != Unsubscribed,
    state.cancelAtPeriodEnd,
    state' = { ...state, cancelAtPeriodEnd: false },
  }

  action scheduleTier(tier: Tier): bool = all {
    rollsPeriod(state.phase),
    state' = { ...state, pending: Pending(tier) },
  }

  action withdrawTier: bool = all {
    isPending(state.pending),
    state' = { ...state, pending: NoTier },
  }

  // A mid-period change replaces the standing's tier immediately and clears a
  // scheduled one. It does not re-grant the plan's pool; the next boundary
  // replaces the plan source. A change re-establishes the line and the pool,
  // so the refill budget starts over (ADR 0031).
  action changeTier(tier: Tier): bool = all {
    rollsPeriod(state.phase),
    state' = {
      ...state,
      tier: tier,
      pending: NoTier,
      topUpAttempts: 0,
    },
  }

  action closePeriod: bool = all {
    canClosePeriod(state),
    state' = applyClosePeriod(state),
  }

  // A dunning rung records that the run reached the attempt. It moves no
  // counter by itself; the charge or the failure that follows does.
  action dunningRung(runId: int, afterAttempt: int): bool = all {
    canDunningRung(state, runId, afterAttempt),
    state' = { ...state, dunningRungs: state.dunningRungs + 1 },
  }

  action spendCredits(amount: int): bool = all {
    canSpend(state, amount),
    state' = spend(state, amount),
  }

  action failTopUp: bool = all {
    allowsUsage(state.phase),
    state' = failedTopUp(state),
  }

  action buyTopUp: bool = all {
    allowsUsage(state.phase),
    state' = boughtTopUp(state),
  }

  action topUpRung(episode: int, attempt: int): bool = all {
    canTopUpRung(state, episode, attempt),
    state' = { ...state, topUpRungs: state.topUpRungs + 1 },
  }

  // Time. The clock stops at the next deadline instead of passing it, so a
  // grace window or a period is never overdue while it is still open.
  action tick: bool = all {
    state.now + 1 <= nextDeadline(state),
    state' = { ...state, now: state.now + 1 },
  }

  action step: bool = {
    nondet tier = TIERS.oneOf()
    nondet graceUntil = 1.to(12).oneOf()
    nondet deadline = 1.to(20).oneOf()
    nondet runId = 0.to(4).oneOf()
    nondet attempt = 0.to(4).oneOf()
    nondet amount = 1.to(20).oneOf()
    any {
      startTrial(tier),
      subscribe(tier),
      extendTrial(deadline),
      enterGrace(graceUntil),
      failPayment(graceUntil),
      recordPayment,
      recover,
      graceElapsed,
      expire,
      scheduleCancellation,
      resume,
      scheduleTier(tier),
      withdrawTier,
      changeTier(tier),
      closePeriod,
      dunningRung(runId, attempt),
      spendCredits(amount),
      failTopUp,
      buyTopUp,
      topUpRung(runId, attempt),
      tick,
    }
  }

  action init: bool = all {
    state' = {
      phase: Unsubscribed,
      tier: Free,
      now: 0,
      periodEnd: PERIOD_LENGTH,
      trialUsed: false,
      cancelAtPeriodEnd: false,
      pending: NoTier,
      graceEnd: NO_DEADLINE,
      dunningRun: 0,
      dunningAttempts: 0,
      topUpAttempts: 0,
      topUpEpisode: 0,
      planCredits: 0,
      planGranted: 0,
      planSpent: 0,
      planExpired: 0,
      lifetimeCredits: 0,
      lifetimeGranted: 0,
      lifetimeSpent: 0,
      dunningRungs: 0,
      topUpRungs: 0,
    },
  }

  // ── witnesses ──────────────────────────────────────────────────────────────

  val trialing: bool = state.phase == Trialing

  val active: bool = state.phase == Active

  val inGrace: bool = state.phase == Grace

  val expired: bool = state.phase == Expired

  val canceled: bool = state.phase == Canceled

  val trialExtended: bool =
    state.phase == Trialing and state.periodEnd > PERIOD_LENGTH

  val periodRolled: bool = rollsPeriod(state.phase) and state.periodEnd > PERIOD_LENGTH

  val cancellationScheduled: bool = state.cancelAtPeriodEnd and rollsPeriod(state.phase)

  val tierScheduled: bool = isPending(state.pending)

  val tierChanged: bool = state.tier != Free and rollsPeriod(state.phase)

  // A scheduled change landed at the boundary: the pending field is empty and
  // the period has rolled past its first end.
  val pendingApplied: bool =
    not(isPending(state.pending)) and rollsPeriod(state.phase) and state.periodEnd > PERIOD_LENGTH

  val dunningRunStarted: bool =
    state.phase == Grace and state.dunningRun > 0 and state.dunningAttempts > 0

  val dunningRungFired: bool = state.dunningRungs > 0 and state.phase == Grace

  val topUpBudgetStarted: bool = state.topUpAttempts > 0

  val creditsSpent: bool = state.planSpent > 0

  val lifetimeCreditsSpent: bool = state.lifetimeSpent > 0

  val topUpRungFired: bool = state.topUpRungs > 0 and allowsUsage(state.phase)

  // A lifetime source survives a close: the plan pool is empty and the
  // lifetime pool is not.
  val lifetimeCreditsSurviveClose: bool =
    state.lifetimeCredits > 0 and state.planCredits == 0 and state.periodEnd > PERIOD_LENGTH

  // A scheduled change replaces the plan source and leaves the lifetime source
  // alone. The plan is at the new grant, and the lifetime pool is still there.
  val lifetimeCreditsSurvivePendingChange: bool =
    state.lifetimeCredits > 0
      and state.planCredits == grantOf(state.tier)
      and state.periodEnd > PERIOD_LENGTH
}
