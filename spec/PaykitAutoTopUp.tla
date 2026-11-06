--------------------------- MODULE PaykitAutoTopUp ---------------------------
\* An auto top-up is a purchase on a crossing: a spend takes the account's
\* credit pool from above its tier's top-up line to at or below it, and the
\* policy opens an invoice for one pack and records the purchase under one
\* command id. A committed event is delivered at least once, so the policy may
\* run again for the same crossing; the command id is what makes that a replay
\* rather than a second pack.
\*
\* Two ways the id can be wrong are worth a model. A key that changes on every
\* attempt makes a redelivery buy again. A key that is the same for every
\* crossing makes a later crossing look like a duplicate of the first, so its
\* pack never arrives. The policy also skips a crossing whose pool has already
\* recovered; `ChecksRecovered` is that guard, and without it a late delivery
\* opens an invoice for a need that is no longer there.
\*
\* Mirrors:
\*   packages/paykit/src/Subscription/AutoTopUp.policy.ts   (`crossedThreshold`,
\*     `topUpCommandId`, `AutoTopUpLive`)
\*   packages/paykit/src/Subscription/Subscription.state.ts  (`topUpOf`)
\*   packages/paykit/src/Tier.ts                              (`TopUpThreshold`)
\*   packages/paykit/src/Subscription/PurchaseCredits.command.ts (`CreditsPurchased`)
\*   packages/paykit/src/Store/SqlAggregateStore.ts         (`send`, receipt dedupe)
\*
\* `Threshold` is the standing's `topUp` line, which travels from the catalog
\* through the tier's events. A tier without one never refills: the account
\* never reaches a `React` here, so the model starts from a standing that does.
\*
\* Read spec/README.md beside this file before changing it.
EXTENDS Naturals, FiniteSets

CONSTANTS
  Crossings,       \* the spend events that cross the threshold
  Threshold,       \* the standing tier's top-up line, in credits
  Pack,            \* credits one pack adds
  MaxAttempts,     \* how many deliveries one crossing may see
  MaxBalance,      \* a bound on the pool, so grants terminate
  StableKey,       \* whether one crossing keeps the command id it bought with
  DistinctKeys,    \* whether two crossings get different command ids
  ChecksRecovered  \* whether a delivery after the pool recovered buys nothing

Keys == (Crossings \cup {0}) \X (0..MaxAttempts)

\* The command id the policy uses for an attempt. A stable key ignores the
\* attempt; a distinct key includes the crossing; neither is optional.
Key(s, attempt) ==
  IF ~DistinctKeys THEN <<0, 0>>
  ELSE IF StableKey THEN <<s, 0>>
  ELSE <<s, attempt>>

VARIABLES
  balance,      \* the credit pool after the crossings and any top-up
  attempts,     \* attempts[s]: how many times s's policy reaction has opened an invoice
  invoices,     \* the command ids an invoice was opened under
  recorded,     \* the command ids that recorded a purchase
  purchased,    \* purchased[s]: packs s's crossing actually records
  processed,    \* crossings whose policy reaction finished, by purchase or skip
  skipped,      \* crossings skipped because the pool had recovered
  lateInvoices \* invoices opened after the pool had recovered

vars == <<balance, attempts, invoices, recorded, purchased, processed, skipped, lateInvoices>>

Init ==
  /\ balance = 0
  /\ attempts = [s \in Crossings |-> 0]
  /\ invoices = {}
  /\ recorded = {}
  /\ purchased = [s \in Crossings |-> 0]
  /\ processed = {}
  /\ skipped = {}
  /\ lateInvoices = {}

\* The policy reacts to a crossing: open the invoice for this attempt. A
\* crossing whose pool has recovered is skipped instead (see `Skip`); with
\* `ChecksRecovered` off, the policy opens an invoice anyway, which is the
\* design that buys a pack the account no longer needs.
React(s) ==
  /\ s \in Crossings
  /\ s \notin skipped
  /\ attempts[s] < MaxAttempts
  /\ (balance <= Threshold \/ ~ChecksRecovered)
  /\ attempts' = [attempts EXCEPT ![s] = attempts[s] + 1]
  /\ invoices' = invoices \cup {Key(s, attempts[s])}
  /\ lateInvoices' =
       IF balance > Threshold
       THEN lateInvoices \cup {Key(s, attempts[s])}
       ELSE lateInvoices
  /\ UNCHANGED <<balance, recorded, purchased, processed, skipped>>

\* The invoice was opened and the policy died before the purchase landed, or
\* the delivery is a replay. The store dedupes by the command id: a key already
\* recorded is the receipt it already has, not a second pack.
Record(s) ==
  /\ s \in Crossings
  /\ attempts[s] > 0
  /\ LET key == Key(s, attempts[s] - 1)
     IN /\ key \in invoices
        /\ (key \in recorded \/ balance + Pack <= MaxBalance)
        /\ recorded' = IF key \in recorded THEN recorded ELSE recorded \cup {key}
        /\ purchased' =
             IF key \in recorded
             THEN purchased
             ELSE [purchased EXCEPT ![s] = purchased[s] + 1]
        /\ balance' = IF key \in recorded THEN balance ELSE balance + Pack
        /\ processed' = processed \cup {s}
        /\ UNCHANGED <<attempts, invoices, skipped, lateInvoices>>

\* A delivery after the pool recovered is a late delivery, not a reason to buy.
Skip(s) ==
  /\ s \in Crossings
  /\ ChecksRecovered
  /\ s \notin skipped
  /\ balance > Threshold
  /\ skipped' = skipped \cup {s}
  /\ processed' = processed \cup {s}
  /\ UNCHANGED <<balance, attempts, invoices, recorded, purchased, lateInvoices>>

\* A grant or another non-spend credit move lifts the pool above the line, so a
\* delivery that arrives afterwards sees a recovered account.
Grant(amount) ==
  /\ amount \in 1..Pack
  /\ balance + amount <= MaxBalance
  /\ balance' = balance + amount
  /\ UNCHANGED <<attempts, invoices, recorded, purchased, processed, skipped, lateInvoices>>

Next ==
  \/ \E s \in Crossings : React(s)
  \/ \E s \in Crossings : Record(s)
  \/ \E s \in Crossings : Skip(s)
  \/ \E amount \in 1..Pack : Grant(amount)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ balance \in 0..MaxBalance
  /\ \A s \in Crossings : attempts[s] \in 0..MaxAttempts
  /\ \A s \in Crossings : purchased[s] \in 0..MaxAttempts
  /\ invoices \subseteq Keys
  /\ recorded \subseteq Keys
  /\ lateInvoices \subseteq Keys
  /\ processed \subseteq Crossings
  /\ skipped \subseteq Crossings

\* A redelivery under a stable key is a replay, not a second pack.
AtMostOnePurchasePerCrossing ==
  \A s \in Crossings : purchased[s] <= 1

\* Every crossing the policy finished (and did not skip as a late delivery)
\* gets its own pack. A command id shared by two crossings makes the second a
\* duplicate of the first, so its credits never arrive.
EveryProcessedCrossingHasItsPack ==
  \A s \in processed \ skipped : purchased[s] = 1

\* No invoice is opened after the pool recovered; the policy's balance check is
\* what keeps a late delivery from buying a pack the account no longer needs.
LateDeliveriesOpenNoInvoice == lateInvoices = {}
=============================================================================
