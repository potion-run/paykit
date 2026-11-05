# spec

TLA+ models of the parts of paykit that no test can reach: two writers on one
account, a scheduled command that fires while a caller does something else, a
period that bills two prices, an outbox that redelivers, and a process that dies
between the push and the record of it. A test walks one thread through time; a
model checker walks every interleaving and stops at the first one that breaks a
rule.

```sh
pnpm spec
```

`scripts/check-spec.ts` runs every `<Name>.cfg` beside its `<Name>.tla` through
[`tla-ts`](https://github.com/aidenybai/tla-ts) — TLC without the JVM, so this
gate needs nothing beyond `pnpm install`. A run must reach `success`.

## The models

| Model | What it decides | Mirrors |
| --- | --- | --- |
| `PaykitReport` | A closed period's usage reaches the vendor once, with the quantity that period closed with. | `Subscription/PeriodCloseUsage.policy.ts`, `Subscription/PeriodRollover.policy.ts`, the outbox in `Store/SqlAggregateStore.ts` |
| `PaykitStore` | The state row beside the log is always the log folded. | `Store/SqlAggregateStore.ts` (`send`), `Store/SqlEventLog.ts` (`append`) |
| `PaykitReportSplit` | A period that billed two prices reports each unit at the price it was recorded at, and the vendor receives all of them. | `Subscription/PeriodCloseUsage.policy.ts`, and the mid-period price change in [`docs/NEXT.md`](../docs/NEXT.md) |
| `PaykitCreditClose` | A close returns the plan's credits and keeps the pack, and open holds stay covered by the pool. | `Subscription/Subscription.aggregate.ts` (`Hold`, `SettleHold`, `closePeriodEvents`), `Subscription/Subscription.state.ts`, `Catalog.ts` (`CatalogCreditFeatureHasAllowance`) |

## The invariants that carry the weight

`PaykitReport`

- **`ReportedQuantityIsClosing`** — what the vendor is sent is `frozen[p]`, the
  billable units the period closed with, not a later read of `used`.
- **`OneQuantityPerPeriod`** — the period is the idempotency key, so a second
  push for the same period is the same number. `PushThenCrash` is a push that
  lands and a process that dies before the outbox marks the delivery done.
- **`NoReportWithoutClose`**, **`OutboxIsClosed`** — the vendor never hears about
  a period the aggregate did not close.

`PaykitStore`

- **`StateIsFoldOfLog`** — `pool` equals the log's fold. Everything a read model
  rebuilds, and every "the log is the record" claim, is this equality.
- **`NeverOverdrawn`** — no prefix of the log spends more than the pool held. A
  pool below zero is a state no read can explain.
- **`VersionCountsEvents`** — the version and the log agree on how many events
  there are.

`PaykitReportSplit`

- **`SplitConservesBillable`** — the units reported per price add up to what the
  period would have reported in one number. The free grant belongs to the
  period, not to the price: charging it per price gives the same grant away once
  per price and the total stops matching the usage.
- **`MeterHoldsTheClosingQuantity`**, **`EveryBillableUnitArrived`** — every
  report carries its own price's closing quantity, and nothing is lost on the
  way. This is where the idempotency key decides the outcome.

`PaykitCreditClose`

- **`PrepaidWithinPool`** — `0 <= prepaidCredits <= credits`, the invariant the
  state file states in a comment.
- **`HoldsAreCovered`** — what open holds reserved is still in the pool to pay
  them with, so `availableOf` never answers below zero.
- **`CloseKeepsThePack`** — the boundary returns the plan's credits and what a
  pack bought is still there afterwards, exactly as much of it.

## A model that has never failed is a model nobody has tested

Each config carries one constant that decides whether the model describes the
good design or the broken one. Flipping it must produce a counterexample; if it
does not, the invariant above it is not load-bearing and should be rewritten or
deleted.

```sh
# PaykitReport: read usage when the delivery runs instead of when it closed
sed 's/ReadsLiveUsage = FALSE/ReadsLiveUsage = TRUE/' spec/PaykitReport.cfg > /tmp/live.cfg
# PaykitStore: append a decision without checking the version it was made on
sed 's/ChecksVersion = TRUE/ChecksVersion = FALSE/' spec/PaykitStore.cfg > /tmp/stale.cfg
# PaykitReportSplit: key the vendor report by the period alone
sed 's/KeyIncludesPrice = TRUE/KeyIncludesPrice = FALSE/' spec/PaykitReportSplit.cfg > /tmp/key.cfg
# PaykitReportSplit: grant the free units once per price, not once per period
sed 's/SharesIncluded = TRUE/SharesIncluded = FALSE/' spec/PaykitReportSplit.cfg > /tmp/free.cfg
# PaykitCreditClose: let an open hold survive the close, which the catalog forbids
sed 's/KeepsHolds = FALSE/KeepsHolds = TRUE/' spec/PaykitCreditClose.cfg > /tmp/kept.cfg
```

Every one of them produces a trace today: `ReportedQuantityIsClosing`,
`StateIsFoldOfLog`, `MeterHoldsTheClosingQuantity`, `SplitConservesBillable` and
`HoldsAreCovered`. The store one models what the code did before the fix
described below, so it stays as the test of the invariant rather than as dead
history.

## What the model does not cover

- **`decide` arithmetic.** It is pure and single-threaded, and
  `packages/paykit/test/{properties,stories,conformance}` already own it.
  Modelling numbers a test already pins is sunk cost; the model is for the
  interleavings around them — the one exception is `PaykitReportSplit`, which
  models arithmetic the code does not do yet.
- **The vendor.** Anything about what Stripe or Polar actually does belongs in
  the gated live tests. The model checks paykit's side of the contract.
- **Liveness.** The models are safety only. `ReportedQuantityIsClosing` says a
  report is right if it happens, not that it happens; at-least-once delivery
  comes from the outbox, not from a model.
- **Provisioning.** Whether a `Reconciler` converges against a real API is a
  deployment question, not a design question.

## What it found

`PaykitStore` found that the store's state row could disagree with its own log.
`SqlAggregateStore.send` read and decided **outside** the transaction
`SqlEventLog.append` takes, and `append` stamped `MAX(seq)` without comparing it
to the version the decision was made on. Two writers that read the same version
both committed, and the second published a state computed from a snapshot the
first already spent.

Two things in the code said this was meant to be closed and was not: the store's
own doc comment claimed "`append` takes the account's lock inside its
transaction", and `SqlExecutor.lock(account)` — "take the per-account write lock
for the current transaction" — had no caller anywhere in the repo.

Reproduced against the shipped SQLite driver: a pool of 100, two concurrent
spends of 60, both accepted. The log folded to `-20` while the state row said
`40`.

```
log: 0 + 60 + 60
fold of log: -20
published pool: 40
```

Closed by the `ChecksVersion` arm the model already carried: `append` takes the
`expectedVersion` the decision was made on and answers `conflict` instead of
writing when the log has moved, and `send` re-reads and re-decides — bounded at
32 attempts, because `decide` is pure and a retry is the same command over a
state that moved, not a second effect.

The trace is the test: `test/sql/AggregateStore.test.ts`, "re-decides a command
instead of publishing a state its log cannot explain", runs both spends against
a gate inside `handle` so both reads land before either append. Remove
`expectedVersion` from `send` and it fails.

`ChecksVersion = FALSE` still models the old behaviour, which is what that test
would catch if the check ever went away.

## The two the queue needed

`PaykitReportSplit` and `PaykitCreditClose` did not find a bug. They settled a
design and pinned a rule, which is the other half of what a spec is for.

### Splitting a period's report by price

`PaykitReport` models the close as it is: one quantity per period.
`PaykitReportSplit` models what a mid-period price change needs, and it decides
two things before anyone writes them.

**The free grant belongs to the period.** `Included` is units a period gives
away, so with two prices it is still one grant. The model applies it to the
first units in time order and checks the result against the period's total:

```tla
SplitConservesBillable ==
  \A p \in closed : frozen[p][1] + frozen[p][2] = Billable(recorded[p])
```

Any allocation rule passes that invariant as long as it is an allocation; the
one the model uses is the simplest that consumes the grant once. Charging
`Included` per price (`SharesIncluded = FALSE`) is what fails, because it makes
the period give the grant away twice.

**The idempotency key has to name the price.** `periodUsageCommandId` returns
`period-usage:<start>:<end>` today. Split the report and the second one for a
period is a redelivery of the first: the meter keeps the first quantity and the
second price's units never arrive. `KeyIncludesPrice = FALSE` shows it — a
period that billed 2 units at one price and 1 at the other ends with 2 at the
meter, and one unit is unbilled.

So the queue item needs `period-usage:<start>:<end>:<price>`; a split close that
reuses the current key is worse than not splitting at all, because it loses a
report silently instead of reporting it at the wrong price.

### Why a credit-priced feature cannot carry an allowance

The hazard worth checking was an open credit hold surviving a close and settling
against a pool the close had already emptied: `credits` would go negative and
the reserved total would no longer be covered.

It cannot happen, and the model says why. `CatalogCreditFeatureHasAllowance`
refuses a credit-priced feature any allowance, so `resetOf` never marks one
`kept`, so `UsageReset` always drops its holds at the boundary. `KeepsHolds` is
that design without the catalog rule: set it to `TRUE` and `HoldsAreCovered`
fails on the first close that has a hold open.

The model is the guard on that validation. Delete it, or make `resetOf` keep a
feature the catalogue did not intend, and this is what breaks.

## Counterexamples become tests

A trace is a list of steps with the exact state at each one: `Read(w2)`, `Commit(w1)`,
`Commit(w2)`. That sequence is a test — two fibers, one store, a latch inside
`handle` so both reads land before either append. When a model finds something,
the trace is the test's setup, and the model's invariant is the assertion. That
is the loop: model finds it, test pins it, the bug cannot come back.
