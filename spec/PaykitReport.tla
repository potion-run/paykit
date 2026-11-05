--------------------------- MODULE PaykitReport -----------------------------
\* A closed period's usage reaches the vendor once, with the quantity that
\* period closed with — including when the outbox redelivers it and the process
\* dies between the push and the record of it.
\*
\* Mirrors:
\*   packages/paykit/src/Subscription/PeriodCloseUsage.policy.ts
\*   packages/paykit/src/Subscription/PeriodRollover.policy.ts
\*   packages/paykit/src/Store/SqlAggregateStore.ts   (the outbox and `drain`)
\*
\* Read spec/README.md beside this file before changing it.
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  MaxPeriod,      \* how many periods the model runs for
  Included,       \* units a period includes for free
  MaxUnits,       \* the most units one period can be charged for
  MaxClock,       \* the logical clock's bound
  ReadsLiveUsage  \* whether the policy reads usage when it delivers, not when it closed

Periods == 1..MaxPeriod

\* What the vendor's meter is sent: the part past the included grant. Sending
\* every unit would charge the included grant a second time.
Billable(units) == LET past == units - Included IN IF past > 0 THEN past ELSE 0

VARIABLES
  clock,     \* a logical clock: a period is closable only once its end has come
  open,      \* the period this account has open
  used,      \* units taken in the open period
  closed,    \* the periods `canClosePeriod` has let through
  frozen,    \* frozen[p]: the billable units p closed with
  outbox,    \* closures committed but not yet delivered
  sent       \* <<period, quantity>> pairs the vendor's meter received

vars == <<clock, open, used, closed, frozen, outbox, sent>>

Init ==
  /\ clock = 0
  /\ open = 1
  /\ used = 0
  /\ closed = {}
  /\ frozen = [p \in Periods |-> 0]
  /\ outbox = {}
  /\ sent = {}

\* Time passing. A close is gated on the period having ended, not on a timer.
Tick ==
  /\ clock < MaxClock
  /\ clock' = clock + 1
  /\ UNCHANGED <<open, used, closed, frozen, outbox, sent>>

TrackUsage ==
  /\ used < MaxUnits
  /\ used' = used + 1
  /\ UNCHANGED <<clock, open, closed, frozen, outbox, sent>>

\* `PeriodEnded`: the scheduled command. Past the period's end it closes it and
\* the same transaction writes the outbox row; before it, `canClosePeriod`
\* refuses and nothing is recorded. A second firing for a closed period is
\* refused by the same guard, which is `lastClosedPeriodStart`.
ClosePeriod ==
  /\ clock >= open
  /\ open \notin closed
  /\ closed' = closed \cup {open}
  /\ frozen' = [frozen EXCEPT ![open] = Billable(used)]
  /\ outbox' = outbox \cup {open}
  /\ used' = 0
  /\ open' = IF open < MaxPeriod THEN open + 1 ELSE open
  /\ UNCHANGED <<clock, sent>>

\* The quantity the policy sends. `FALSE` is `state` on the trigger: the
\* `Entitlements` view after `PeriodClosed`, which still holds the closing
\* period's usage. `TRUE` is a re-read once the delivery runs, after
\* `UsageReset` has zeroed those counters.
Quantity(p) == IF ReadsLiveUsage THEN Billable(used) ELSE frozen[p]

\* `PeriodCloseUsage`: the outbox delivers the closure and the policy pushes.
Deliver ==
  \E p \in outbox :
    /\ sent' = sent \cup {<<p, Quantity(p)>>}
    /\ outbox' = outbox \ {p}
    /\ UNCHANGED <<clock, open, used, closed, frozen>>

\* The push lands and the process dies before the delivery is marked done, so
\* the outbox hands the same closure over again.
PushThenCrash ==
  \E p \in outbox :
    /\ sent' = sent \cup {<<p, Quantity(p)>>}
    /\ UNCHANGED <<clock, open, used, closed, frozen, outbox>>

Next == \/ Tick \/ TrackUsage \/ ClosePeriod \/ Deliver \/ PushThenCrash

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ clock \in 0..MaxClock
  /\ open \in Periods
  /\ used \in 0..MaxUnits
  /\ closed \subseteq Periods
  /\ frozen \in [Periods -> 0..MaxUnits]
  /\ outbox \subseteq Periods
  /\ sent \subseteq Periods \X (0..MaxUnits)

\* The outbox never carries a period the aggregate did not close.
OutboxIsClosed == outbox \subseteq closed

\* The vendor never hears about a period this account never closed.
NoReportWithoutClose == \A pair \in sent : pair[1] \in closed

\* A period is never reported with two different quantities. The period is the
\* idempotency key, so a redelivery has to be the same number.
OneQuantityPerPeriod ==
  \A p \in Periods : \A q1, q2 \in 0..MaxUnits :
    <<p, q1>> \in sent /\ <<p, q2>> \in sent => q1 = q2

\* The quantity is the one the period closed with, not whatever the standing
\* looked like when the outbox got around to it.
ReportedQuantityIsClosing == \A pair \in sent : pair[2] = frozen[pair[1]]
=============================================================================
