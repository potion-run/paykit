------------------------- MODULE PaykitCreditClose --------------------------
\* One account's credit pool across a period close, with work in flight. The
\* pool is the unit of account: a pack buys credits that never expire, the plan
\* grants credits that expire at the boundary, and a hold keeps part of the pool
\* out of everyone else's reach until it settles, releases or its deadline comes.
\*
\* A close may also apply a tier change scheduled for the boundary. The close
\* then replaces the grant instead of expiring the old one, and carries the
\* pack through: `scheduled + prepaid`, never `scheduled` alone.
\* `AppliesScheduledGrant` is that rule; with it off, the model is the design
\* that drops a scheduled grant at the boundary. `scheduled` stays on the state
\* after the close as the grant the boundary applied, which is what the close
\* invariants read.
\*
\* Mirrors:
\*   packages/paykit/src/Subscription/Subscription.aggregate.ts  (Hold, SettleHold,
\*     ReleaseHold, ConsumeCredits, closePeriodEvents)
\*   packages/paykit/src/Subscription/Subscription.state.ts      (creditsOf,
\*     prepaidCreditsOf, expiringCreditsOf, protectedAfterSpending, reservedCreditsOf)
\*   packages/paykit/src/Subscription/ScheduleTierChange.command.ts (PendingTier)
\*   packages/paykit/src/Subscription/WithdrawTierChange.command.ts (TierChangeWithdrawn)
\*   packages/paykit/src/Catalog.ts                              (CatalogCreditFeatureHasAllowance)
\*
\* Read spec/README.md beside this file before changing it.
EXTENDS Naturals, FiniteSets

CONSTANTS
  Holds,                \* the hold ids a caller may take
  Pool0,                \* the credits the account starts with
  Prepaid0,             \* the part of Pool0 a one-off pack bought
  MaxCost,              \* the most credits one hold or one spend takes
  MaxPool,              \* a bound on the pool, so grants and purchases terminate
  MaxGrant,             \* the largest grant a scheduled tier change may carry
  MaxClock,             \* the logical clock's bound
  ExpiresAtClose,       \* whether the plan's own credits expire at the boundary
  KeepsHolds,           \* whether a close leaves an open hold in place
  AppliesScheduledGrant \* whether a close applies the pending tier's grant

Min(a, b) == IF a < b THEN a ELSE b

NoHolds == [h \in Holds |-> 0]

\* The credits open holds keep out of the pool — `reservedCreditsOf`. Written as
\* a count of one pair per reserved credit, because TLA+ has no fold over a
\* function.
Reserved(reservations) ==
  Cardinality({pair \in Holds \X (1..MaxCost) : pair[2] <= reservations[pair[1]]})

\* A pack's part after the pool moved down: `protectedAfterSpending`.
Protected(prepaid, balance) == Min(prepaid, balance)

VARIABLES
  clock,      \* a logical clock: a close and a deadline both read it
  credits,    \* the pool
  prepaid,    \* the part of the pool a one-off pack bought
  held,       \* held[h]: credits h keeps out of the pool, 0 when it is closed
  deadline,   \* deadline[h]: the clock reading h expires at
  scheduled,  \* the grant a scheduled tier change will apply, 0 when none
  closed      \* whether the period boundary has passed

vars == <<clock, credits, prepaid, held, deadline, scheduled, closed>>

Init ==
  /\ clock = 0
  /\ credits = Pool0
  /\ prepaid = Prepaid0
  /\ held = NoHolds
  /\ deadline = [h \in Holds |-> 0]
  /\ scheduled = 0
  /\ closed = FALSE

Tick ==
  /\ clock < MaxClock
  /\ clock' = clock + 1
  /\ UNCHANGED <<credits, prepaid, held, deadline, scheduled, closed>>

\* `Hold`: a promise to bill, taken out of what the pool can cover. One the
\* snapshot says cannot be covered is refused, which is what keeps the reserved
\* total under the pool.
Hold(h, cost, at) ==
  /\ ~closed
  /\ h \in Holds
  /\ held[h] = 0
  /\ cost \in 1..MaxCost
  /\ cost <= credits - Reserved(held)
  /\ at \in clock..MaxClock
  /\ held' = [held EXCEPT ![h] = cost]
  /\ deadline' = [deadline EXCEPT ![h] = at]
  /\ UNCHANGED <<clock, credits, prepaid, scheduled, closed>>

\* `SettleHold`: the pool pays the credits the work used, and the hold closes.
Settle(h) ==
  /\ ~closed
  /\ h \in Holds
  /\ held[h] > 0
  /\ credits' = credits - held[h]
  /\ prepaid' = Protected(prepaid, credits')
  /\ held' = [held EXCEPT ![h] = 0]
  /\ UNCHANGED <<clock, deadline, scheduled, closed>>

\* `ReleaseHold` and `HoldElapsed` are both cleanups: they only stop reserving.
Release(h) ==
  /\ ~closed
  /\ h \in Holds
  /\ held[h] > 0
  /\ held' = [held EXCEPT ![h] = 0]
  /\ UNCHANGED <<clock, credits, prepaid, deadline, scheduled, closed>>

Elapse(h) ==
  /\ ~closed
  /\ h \in Holds
  /\ held[h] > 0
  /\ clock >= deadline[h]
  /\ held' = [held EXCEPT ![h] = 0]
  /\ UNCHANGED <<clock, credits, prepaid, deadline, scheduled, closed>>

\* `ConsumeCredits`: spend from the pool, never from what an open hold reserved.
Spend(amount) ==
  /\ ~closed
  /\ amount \in 1..MaxCost
  /\ amount <= credits - Reserved(held)
  /\ credits' = credits - amount
  /\ prepaid' = Protected(prepaid, credits')
  /\ UNCHANGED <<clock, held, deadline, scheduled, closed>>

\* `PurchaseCredits`: a pack adds credits that never expire.
Purchase(amount) ==
  /\ ~closed
  /\ amount \in 1..MaxCost
  /\ credits + amount <= MaxPool
  /\ credits' = credits + amount
  /\ prepaid' = prepaid + amount
  /\ UNCHANGED <<clock, held, deadline, scheduled, closed>>

\* `GrantCredits`: the plan's own credits, which expire if `ExpiresAtClose`.
Grant(amount) ==
  /\ ~closed
  /\ amount \in 1..MaxCost
  /\ credits + amount <= MaxPool
  /\ credits' = credits + amount
  /\ prepaid' = Protected(prepaid, credits')
  /\ UNCHANGED <<clock, held, deadline, scheduled, closed>>

\* `ScheduleTierChange`: the next close will apply this grant. A second schedule
\* replaces the first, which is the code's one `pendingTier` field.
Schedule(amount) ==
  /\ ~closed
  /\ amount \in 1..MaxGrant
  /\ scheduled' = amount
  /\ UNCHANGED <<clock, credits, prepaid, held, deadline, closed>>

\* `WithdrawTierChange`: the standing drops the schedule and keeps what it had.
Withdraw ==
  /\ ~closed
  /\ scheduled > 0
  /\ scheduled' = 0
  /\ UNCHANGED <<clock, credits, prepaid, held, deadline, closed>>

\* `PeriodEnded`: the close applies a scheduled grant, or returns the plan's own
\* credits when there is none, and keeps the pack either way. The model stops
\* here — what follows is the next period, which is this model again — so the
\* boundary itself is the last state worth naming. A credit-priced feature can
\* never carry an allowance (`CatalogCreditFeatureHasAllowance`), so `UsageReset`
\* always drops its holds; `KeepsHolds` models the design in which it does not.
Close ==
  /\ closed = FALSE
  /\ LET grant == IF AppliesScheduledGrant /\ scheduled > 0 THEN scheduled ELSE 0
         next == IF grant > 0
                 THEN grant + prepaid
                 ELSE IF ExpiresAtClose THEN prepaid ELSE credits
     IN /\ credits' = next
        /\ prepaid' = Protected(prepaid, next)
        /\ held' = IF KeepsHolds THEN held ELSE NoHolds
        /\ closed' = TRUE
        /\ UNCHANGED <<clock, deadline, scheduled>>

Next ==
  \/ Tick
  \/ \E h \in Holds, cost \in 1..MaxCost, at \in clock..MaxClock : Hold(h, cost, at)
  \/ \E h \in Holds : Settle(h)
  \/ \E h \in Holds : Release(h)
  \/ \E h \in Holds : Elapse(h)
  \/ \E amount \in 1..MaxCost : Spend(amount)
  \/ \E amount \in 1..MaxCost : Purchase(amount)
  \/ \E amount \in 1..MaxCost : Grant(amount)
  \/ \E amount \in 1..MaxGrant : Schedule(amount)
  \/ Withdraw
  \/ Close

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ clock \in 0..MaxClock
  /\ credits \in 0..MaxPool + MaxGrant
  /\ prepaid \in 0..MaxPool + MaxGrant
  /\ \A h \in Holds : held[h] \in 0..MaxCost
  /\ \A h \in Holds : deadline[h] \in 0..MaxClock
  /\ scheduled \in 0..MaxGrant
  /\ closed \in BOOLEAN

\* The pack never outgrows the pool, and the pool never goes below zero: a
\* balance no read can explain is one an account can be charged against.
PrepaidWithinPool == prepaid <= credits

\* What open holds reserved is still there to pay them with — `availableOf` for a
\* credit-priced feature is `credits - reservedCredits`, and a negative answer is
\* capacity that never existed.
HoldsAreCovered == Reserved(held) <= credits

\* A scheduled grant is in the pool, next to the pack the close kept. With
\* `AppliesScheduledGrant` off, the boundary takes the no-change path and the
\* new tier's credits never arrive, so `credits` is not `scheduled + prepaid`.
\* The same expression is the pack's check: a close that dropped the one-off
\* part would not have `prepaid` left to add here.
CloseAppliedTheScheduledCredits ==
  closed /\ scheduled > 0 => credits = scheduled + prepaid

\* With no scheduled change, a close returns the plan's credits and nothing
\* else: what a pack bought is still there afterwards, exactly as much of it.
CloseExpiresOnlyWithoutChange ==
  closed /\ scheduled = 0 /\ ExpiresAtClose => credits = prepaid
=============================================================================
