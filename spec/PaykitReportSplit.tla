------------------------- MODULE PaykitReportSplit --------------------------
\* A period's usage can be recorded at more than one price: a tier change
\* mid-period retires one vendor price and sells the next unit under another.
\* The close reports each unit at the price it was recorded at, in one report
\* that carries a line per price, and the vendor receives all of them.
\*
\* Mirrors `Subscription/PeriodCloseUsage.policy.ts` (`billableLines`),
\* `Subscription/Entitlements.view.ts` (`FeatureEntitlement.priced`) and
\* `Subscription/TrackUsage.command.ts` (`UsageRecorded.billable`).
\*
\* Read spec/README.md beside this file before changing it.
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  MaxPeriod,          \* how many periods the model runs for
  MaxUnits,           \* the most units one period records
  MaxClock,           \* the logical clock's bound
  Included,           \* free units per period, granted once across the period
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

\* What the vendor's meter is owed for a period: the part past the grant.
Billable(usage) == Max2(0, Len(usage) - Included)

VARIABLES
  clock,      \* a logical clock: a period is closable only once its end has come
  open,       \* the period this account has open
  recorded,   \* recorded[p]: the prices of p's units, in the order they were taken
  closed,     \* the periods the aggregate has closed
  frozen,     \* frozen[p][v]: the billable units p closed with, per price
  outbox,     \* the periods whose report the store still has to deliver
  delivered,  \* the periods whose report the vendor accepted
  vendor      \* vendor[p][v]: the units the meter holds for p at price v

vars == <<clock, open, recorded, closed, frozen, outbox, delivered, vendor>>

Init ==
  /\ clock = 0
  /\ open = 1
  /\ recorded = [p \in Periods |-> <<>>]
  /\ closed = {}
  /\ frozen = [p \in Periods |-> [v \in Prices |-> 0]]
  /\ outbox = {}
  /\ delivered = {}
  /\ vendor = [p \in Periods |-> [v \in Prices |-> 0]]

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

\* `PeriodEnded`: the close freezes the period's billable units per price and
\* writes one report carrying all of them. The report is a function of the
\* period, so a redelivery is the same payload.
ClosePeriod ==
  /\ clock >= open
  /\ open \notin closed
  /\ closed' = closed \cup {open}
  /\ frozen' = [frozen EXCEPT ![open] = Freeze(recorded[open])]
  /\ outbox' = outbox \cup {open}
  /\ open' = IF open < MaxPeriod THEN open + 1 ELSE open
  /\ UNCHANGED <<clock, recorded, delivered, vendor>>

\* `PeriodCloseUsage`: the outbox hands the report to the provider, which keys
\* it by the period, so a second delivery is the same report to the meter.
Deliver(p) ==
  /\ p \in outbox
  /\ outbox' = outbox \ {p}
  /\ delivered' = delivered \cup {p}
  /\ vendor' = [vendor EXCEPT ![p] = frozen[p]]
  /\ UNCHANGED <<clock, open, recorded, closed, frozen>>

Next ==
  \/ Tick
  \/ \E v \in Prices : TrackUsage(v)
  \/ ClosePeriod
  \/ \E p \in outbox : Deliver(p)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ clock \in 0..MaxClock
  /\ open \in Periods
  /\ \A p \in Periods : Len(recorded[p]) \in 0..MaxUnits
  /\ closed \subseteq Periods
  /\ outbox \subseteq Periods
  /\ delivered \subseteq Periods
  /\ \A p \in Periods, v \in Prices : frozen[p][v] \in 0..MaxUnits
  /\ \A p \in Periods, v \in Prices : vendor[p][v] \in 0..MaxUnits

\* The split conserves the period's billable units: reporting by price gives the
\* same total as reporting the period in one number.
SplitConservesBillable ==
  \A p \in closed : frozen[p][1] + frozen[p][2] = Billable(recorded[p])

\* Nothing reaches the meter for a period the aggregate did not close.
NoReportWithoutClose == delivered \subseteq closed

\* Every delivered report carries the period's closing quantity at each price.
ReportNamesEveryPrice ==
  \A p \in delivered, v \in Prices : vendor[p][v] = frozen[p][v]

\* Once a period is delivered, every price it billed for is at the meter — one
\* lost line is one unbilled unit.
EveryBillableUnitArrived ==
  \A p \in delivered, v \in Prices : frozen[p][v] = 0 \/ vendor[p][v] = frozen[p][v]
=============================================================================
