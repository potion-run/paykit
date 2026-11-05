------------------------- MODULE PaykitCreditClose --------------------------
\* One account's credit pool across a period close, with work in flight. The
\* pool is the unit of account: a pack buys credits that never expire, the plan
\* grants credits that expire at the boundary, and a hold keeps part of the pool
\* out of everyone else's reach until it settles, releases or its deadline comes.
\*
\* Mirrors:
\*   packages/paykit/src/Subscription/Subscription.aggregate.ts  (Hold, SettleHold,
\*     ReleaseHold, ConsumeCredits, closePeriodEvents)
\*   packages/paykit/src/Subscription/Subscription.state.ts      (creditsOf,
\*     prepaidCreditsOf, expiringCreditsOf, protectedAfterSpending, reservedCreditsOf)
\*   packages/paykit/src/Catalog.ts                              (CatalogCreditFeatureHasAllowance)
\*
\* Read spec/README.md beside this file before changing it.
EXTENDS Naturals, FiniteSets

CONSTANTS
  Holds,          \* the hold ids a caller may take
  Pool0,          \* the credits the account starts with
  Prepaid0,       \* the part of Pool0 a one-off pack bought
  MaxCost,        \* the most credits one hold or one spend takes
  MaxPool,        \* a bound on the pool, so grants and purchases terminate
  MaxClock,       \* the logical clock's bound
  ExpiresAtClose, \* whether the plan's own credits expire at the boundary
  KeepsHolds      \* whether a close leaves an open hold in place

Min(a, b) == IF a < b THEN a ELSE b

\* The credits open holds keep out of the pool — `reservedCreditsOf`. Written as
\* a count of one pair per reserved credit, because TLA+ has no fold over a
\* function.
Reserved(reservations) ==
  Cardinality({pair \in Holds \X (1..MaxCost) : pair[2] <= reservations[pair[1]]})

\* A pack's part after the pool moved down: `protectedAfterSpending`.
Protected(prepaid, balance) == Min(prepaid, balance)

VARIABLES
  clock,     \* a logical clock: a close and a deadline both read it
  credits,   \* the pool
  prepaid,   \* the part of the pool a one-off pack bought
  held,      \* held[h]: credits h keeps out of the pool, 0 when it is closed
  deadline,  \* deadline[h]: the clock reading h expires at
  closed     \* whether the period boundary has passed

vars == <<clock, credits, prepaid, held, deadline, closed>>

Init ==
  /\ clock = 0
  /\ credits = Pool0
  /\ prepaid = Prepaid0
  /\ held = [h \in Holds |-> 0]
  /\ deadline = [h \in Holds |-> 0]
  /\ closed = FALSE

Tick ==
  /\ clock < MaxClock
  /\ clock' = clock + 1
  /\ UNCHANGED <<credits, prepaid, held, deadline, closed>>

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
  /\ UNCHANGED <<clock, credits, prepaid, closed>>

\* `SettleHold`: the pool pays the credits the work used, and the hold closes.
Settle(h) ==
  /\ ~closed
  /\ h \in Holds
  /\ held[h] > 0
  /\ credits' = credits - held[h]
  /\ prepaid' = Protected(prepaid, credits')
  /\ held' = [held EXCEPT ![h] = 0]
  /\ UNCHANGED <<clock, deadline, closed>>

\* `ReleaseHold` and `HoldElapsed` are both cleanups: they only stop reserving.
Release(h) ==
  /\ ~closed
  /\ h \in Holds
  /\ held[h] > 0
  /\ held' = [held EXCEPT ![h] = 0]
  /\ UNCHANGED <<clock, credits, prepaid, deadline, closed>>

Elapse(h) ==
  /\ ~closed
  /\ h \in Holds
  /\ held[h] > 0
  /\ clock >= deadline[h]
  /\ held' = [held EXCEPT ![h] = 0]
  /\ UNCHANGED <<clock, credits, prepaid, deadline, closed>>

\* `ConsumeCredits`: spend from the pool, never from what an open hold reserved.
Spend(amount) ==
  /\ ~closed
  /\ amount \in 1..MaxCost
  /\ amount <= credits - Reserved(held)
  /\ credits' = credits - amount
  /\ prepaid' = Protected(prepaid, credits')
  /\ UNCHANGED <<clock, held, deadline, closed>>

\* `PurchaseCredits`: a pack adds credits that never expire.
Purchase(amount) ==
  /\ ~closed
  /\ amount \in 1..MaxCost
  /\ credits + amount <= MaxPool
  /\ credits' = credits + amount
  /\ prepaid' = prepaid + amount
  /\ UNCHANGED <<clock, held, deadline, closed>>

\* `GrantCredits`: the plan's own credits, which expire if `ExpiresAtClose`.
Grant(amount) ==
  /\ ~closed
  /\ amount \in 1..MaxCost
  /\ credits + amount <= MaxPool
  /\ credits' = credits + amount
  /\ prepaid' = Protected(prepaid, credits')
  /\ UNCHANGED <<clock, held, deadline, closed>>

\* `PeriodEnded`: the close returns the plan's credits and keeps the pack. The
\* model stops here — what follows is the next period, which is this model
\* again — so the boundary itself is the last state worth naming. A
\* credit-priced feature can never carry an allowance
\* (`CatalogCreditFeatureHasAllowance`), so `UsageReset` always drops its holds;
\* `KeepsHolds` models the design in which it does not.
Close ==
  /\ closed = FALSE
  /\ credits' = IF ExpiresAtClose THEN prepaid ELSE credits
  /\ prepaid' = Protected(prepaid, credits')
  /\ held' = IF KeepsHolds THEN held ELSE [h \in Holds |-> 0]
  /\ closed' = TRUE
  /\ UNCHANGED <<clock, deadline>>

Next ==
  \/ Tick
  \/ \E h \in Holds, cost \in 1..MaxCost, at \in clock..MaxClock : Hold(h, cost, at)
  \/ \E h \in Holds : Settle(h)
  \/ \E h \in Holds : Release(h)
  \/ \E h \in Holds : Elapse(h)
  \/ \E amount \in 1..MaxCost : Spend(amount)
  \/ \E amount \in 1..MaxCost : Purchase(amount)
  \/ \E amount \in 1..MaxCost : Grant(amount)
  \/ Close

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ clock \in 0..MaxClock
  /\ credits \in 0..MaxPool
  /\ prepaid \in 0..MaxPool
  /\ \A h \in Holds : held[h] \in 0..MaxCost
  /\ \A h \in Holds : deadline[h] \in 0..MaxClock
  /\ closed \in BOOLEAN

\* The pack never outgrows the pool, and the pool never goes below zero: a
\* balance no read can explain is one an account can be charged against.
PrepaidWithinPool == prepaid <= credits

\* What open holds reserved is still there to pay them with — `availableOf` for a
\* credit-priced feature is `credits - reservedCredits`, and a negative answer is
\* capacity that never existed.
HoldsAreCovered == Reserved(held) <= credits

\* A close returns the plan's credits and nothing else: what a pack bought is
\* still there afterwards, exactly as much of it as there was.
CloseKeepsThePack == closed => prepaid <= credits /\ (ExpiresAtClose => credits = prepaid)

=============================================================================
