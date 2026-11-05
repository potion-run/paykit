------------------------- MODULE PaykitReportSplit --------------------------
\* A period's usage can be recorded at more than one price: a tier change or a
\* catalog edit mid-period retires one vendor price and the next unit is sold
\* under another. The close must report each unit at the price it was recorded
\* at, and the vendor must receive all of them.
\*
\* This is the design the queue needs, not the code as it stands: `PaykitReport`
\* is today's close, which sends one quantity per period.
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  MaxPeriod,          \* how many periods the model runs for
  MaxUnits,           \* the most units one period records
  MaxClock,           \* the logical clock's bound
  Included,           \* free units per period, granted once across the period
  KeyIncludesPrice,   \* whether the vendor's idempotency key names the price
  SharesIncluded      \* whether the free units are shared across a period's prices

Periods == 1..MaxPeriod
Prices == 1..2
Max2(a, b) == IF a > b THEN a ELSE b

\* The units a period bills at each price, given the period's usage in the order
\* it was recorded. `SharesIncluded` is the design under test: a period grants
\* `Included` once, so the first units in time order are free and only the rest
\* bill. Counting the grant per price instead would give it away once per price,
\* which is a different period than the one that was used.
Freeze(usage) ==
  IF SharesIncluded
  THEN [v \in Prices |-> Cardinality({i \in 1..Len(usage) : usage[i] = v /\ i > Included})]
  ELSE [v \in Prices |->
          Max2(0, Cardinality({i \in 1..Len(usage) : usage[i] = v}) - Included)]

\* What the vendor's meter is sent for a period: the part past the grant.
Billable(usage) == Max2(0, Len(usage) - Included)

\* The idempotency key one report carries. The period names the report; the
\* price has to name it too, or the second report for a period is a redelivery
\* of the first and its units never arrive.
Keys == IF KeyIncludesPrice THEN Periods \X Prices ELSE Periods \X {0}
KeyOf(report) == IF KeyIncludesPrice THEN report ELSE <<report[1], 0>>

VARIABLES
  clock,      \* a logical clock: a period is closable only once its end has come
  open,       \* the period this account has open
  recorded,   \* recorded[p]: the prices of p's units, in the order they were taken
  closed,     \* the periods the aggregate has closed
  frozen,     \* frozen[p][v]: the billable units p closed with, per price
  outbox,     \* <<period, price>> reports the store still has to deliver
  delivered,  \* the reports handed to the vendor's meter
  vendor      \* vendor[key]: the quantity the meter holds for that key, 0 for none

vars == <<clock, open, recorded, closed, frozen, outbox, delivered, vendor>>

Init ==
  /\ clock = 0
  /\ open = 1
  /\ recorded = [p \in Periods |-> <<>>]
  /\ closed = {}
  /\ frozen = [p \in Periods |-> [v \in Prices |-> 0]]
  /\ outbox = {}
  /\ delivered = {}
  /\ vendor = [k \in Keys |-> 0]

Tick ==
  /\ clock < MaxClock
  /\ clock' = clock + 1
  /\ UNCHANGED <<open, recorded, closed, frozen, outbox, delivered, vendor>>

\* One unit taken at the price in effect now. The model does not track which
\* price is current, so a change may land anywhere in the period: that is the
\* strongest form of the problem, not the weakest.
TrackUsage(v) ==
  /\ v \in Prices
  /\ open \notin closed
  /\ Len(recorded[open]) < MaxUnits
  /\ recorded' = [recorded EXCEPT ![open] = Append(recorded[open], v)]
  /\ UNCHANGED <<clock, open, closed, frozen, outbox, delivered, vendor>>

ClosePeriod ==
  /\ clock >= open
  /\ open \notin closed
  /\ closed' = closed \cup {open}
  /\ frozen' = [frozen EXCEPT ![open] = Freeze(recorded[open])]
  /\ outbox' = outbox \cup {<<open, v>> : v \in {w \in Prices : Freeze(recorded[open])[w] > 0}}
  /\ open' = IF open < MaxPeriod THEN open + 1 ELSE open
  /\ UNCHANGED <<clock, recorded, delivered, vendor>>

\* `PeriodCloseUsage`: the outbox hands one report to the provider, which keys
\* it, so a second report under the same key is the same report to the meter.
Deliver(report) ==
  /\ report \in outbox
  /\ outbox' = outbox \ {report}
  /\ delivered' = delivered \cup {report}
  /\ vendor' = IF vendor[KeyOf(report)] = 0
               THEN [vendor EXCEPT ![KeyOf(report)] = frozen[report[1]][report[2]]]
               ELSE vendor
  /\ UNCHANGED <<clock, open, recorded, closed, frozen>>

Next ==
  \/ Tick
  \/ \E v \in Prices : TrackUsage(v)
  \/ ClosePeriod
  \/ \E report \in outbox : Deliver(report)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ clock \in 0..MaxClock
  /\ open \in Periods
  /\ \A p \in Periods : Len(recorded[p]) \in 0..MaxUnits
  /\ \A p \in Periods, v \in Prices : frozen[p][v] \in 0..MaxUnits
  /\ closed \subseteq Periods
  /\ outbox \subseteq Periods \X Prices
  /\ delivered \subseteq Periods \X Prices
  /\ vendor \in [Keys -> 0..MaxUnits]

\* The split conserves the period's billable units: reporting by price gives the
\* same total as reporting the period in one number.
SplitConservesBillable ==
  \A p \in closed : frozen[p][1] + frozen[p][2] = Billable(recorded[p])

\* Nothing reaches the meter for a period the aggregate did not close.
NoReportWithoutClose == \A report \in delivered : report[1] \in closed

\* Every report the meter accepted carries the number that period closed with
\* at that price.
MeterHoldsTheClosingQuantity ==
  \A report \in delivered :
    vendor[KeyOf(report)] = 0 \/ vendor[KeyOf(report)] = frozen[report[1]][report[2]]

\* Once every report is delivered, every price a period billed for is at the
\* meter with the right number — one lost report is one lost charge.
EveryBillableUnitArrived ==
  LET everythingDelivered ==
        \A p \in closed : {<<p, v>> : v \in {w \in Prices : frozen[p][w] > 0}} \subseteq delivered
  IN everythingDelivered =>
       \A p \in closed, v \in Prices :
         frozen[p][v] = 0 \/ vendor[KeyOf(<<p, v>>)] = frozen[p][v]
=============================================================================
