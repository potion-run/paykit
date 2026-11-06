---------------------------- MODULE PaykitStore -----------------------------
\* The store is event-sourced: the log is the truth and the state row beside it
\* is a cache. This module checks that the cache is always the log folded — the
\* one property a rebuild, a read model and every invariant downstream rest on.
\*
\* Mirrors:
\*   packages/paykit/src/Store/SqlAggregateStore.ts   (`attemptSend`, `send`: read,
\*     decide, append, re-decide on conflict)
\*   packages/paykit/src/Store/SqlEventLog.ts         (`append`: lock, receipt,
\*     `expectedVersion`)
\*
\* The model carries the version the decision was made on. Receipt dedupe and
\* the bounded re-decide are not extra state here: they remove interleavings the
\* model already rejects, and the tests named in spec/README.md pin them.
\*
\* Read spec/README.md beside this file before changing it.
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  Writers,       \* the processes that send commands to one account
  InitialPool,   \* the credit pool the account starts with
  MaxSpend,      \* the most one command may spend
  MaxCommands,   \* a bound on how many commands the model runs
  ChecksVersion  \* whether the append refuses a decision made on a stale read

RECURSIVE PoolAt(_, _)
\* The pool, as the log says it is after the first `n` events.
PoolAt(records, n) == IF n = 0 THEN InitialPool ELSE PoolAt(records, n - 1) - records[n].amount

\* What a writer holds between steps: nothing, or the read/decision it made.
NoSnapshot == [has |-> FALSE, version |-> 0, pool |-> 0]
NoDecision == [has |-> FALSE, version |-> 0, pool |-> 0, amount |-> 1]

VARIABLES
  version,   \* the published version: one per event appended
  pool,      \* the published pool: the state row beside the log
  log,       \* the events appended, oldest first
  snapshot,  \* snapshot[w]: what writer w last read
  decision   \* decision[w]: what w decided on that snapshot

vars == <<version, pool, log, snapshot, decision>>

Init ==
  /\ version = 0
  /\ pool = InitialPool
  /\ log = <<>>
  /\ snapshot = [w \in Writers |-> NoSnapshot]
  /\ decision = [w \in Writers |-> NoDecision]

\* `send` reads the store before it decides, and the read is outside the
\* transaction `append` takes.
Read(w) ==
  /\ snapshot' = [snapshot EXCEPT ![w] = [has |-> TRUE, version |-> version, pool |-> pool]]
  /\ decision' = [decision EXCEPT ![w] = NoDecision]
  /\ UNCHANGED <<version, pool, log>>

\* `decide` guards on the snapshot it read: a spend may only draw on a pool the
\* snapshot says can cover it. That is where a pool bottoms out at zero.
Decide(w, amount) ==
  /\ snapshot[w].has
  /\ snapshot[w].pool >= amount
  /\ ~decision[w].has
  /\ decision' = [decision EXCEPT ![w] =
       [has |-> TRUE, version |-> snapshot[w].version, pool |-> snapshot[w].pool,
        amount |-> amount]]
  /\ UNCHANGED <<version, pool, log, snapshot>>

\* `append` locks the instance's state row, then publishes one event and one
\* state row in one transaction. The version it stamps comes from the log's own
\* sequence, so the log stays dense either way; the pool it writes comes from
\* the decision, which may be stale.
Commit(w) ==
  /\ decision[w].has
  /\ (ChecksVersion => decision[w].version = version)
  /\ Len(log) < MaxCommands
  /\ version' = version + 1
  /\ pool' = decision[w].pool - decision[w].amount
  /\ log' = Append(log, [writer |-> w, amount |-> decision[w].amount, poolAfter |-> pool'])
  /\ decision' = [decision EXCEPT ![w] = NoDecision]
  /\ snapshot' = [snapshot EXCEPT ![w] = NoSnapshot]

Next ==
  \/ \E w \in Writers : Read(w)
  \/ \E w \in Writers, amount \in 1..MaxSpend : Decide(w, amount)
  \/ \E w \in Writers : Commit(w)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ version \in 0..MaxCommands
  /\ pool \in 0..InitialPool
  /\ Len(log) \in 0..MaxCommands
  /\ \A w \in Writers :
       snapshot[w] = NoSnapshot
       \/ (snapshot[w].version \in 0..MaxCommands /\ snapshot[w].pool \in 0..InitialPool)
  /\ \A w \in Writers :
       decision[w] = NoDecision
       \/ (decision[w].version \in 0..MaxCommands
           /\ decision[w].pool \in 0..InitialPool
           /\ decision[w].amount \in 1..MaxSpend)

\* The cache is the log folded: every number a reader sees is what the events
\* add up to.
StateIsFoldOfLog == pool = PoolAt(log, Len(log))

\* The version and the log cannot disagree about how many events there are.
VersionCountsEvents == Len(log) = version

\* No prefix of the log spends more than the pool ever held. A pool that goes
\* below zero is a state no read can explain.
NeverOverdrawn == \A n \in 0..Len(log) : PoolAt(log, n) >= 0
=============================================================================
