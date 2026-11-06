# spec

TLA+ models of the parts of paykit that no test can reach: two writers on one
account, a hold deadline firing mid-flight, a scheduled grant applied at the
boundary, a period that bills two prices, an outbox that redelivers, a process
that dies between the push and the record of it, and a top-up policy that runs
twice on one crossing. A test walks one thread through time; a model checker
walks every interleaving and stops at the first one that breaks a rule.

```sh
pnpm spec
```

`scripts/check-spec.ts` runs every `<Name>.cfg` beside its `<Name>.tla` through
[`tla-ts`](https://github.com/aidenybai/tla-ts) — TLC without the JVM, so this
gate needs nothing beyond `pnpm install`. A run must reach `success`.

## The models

| Model | What it decides | Mirrors |
| --- | --- | --- |
| `PaykitStore` | The state row beside the log is always the log folded. | `Store/SqlAggregateStore.ts` (`attemptSend`, `send`), `Store/SqlEventLog.ts` (`append`) |
| `PaykitReportSplit` | A period that billed two prices reports each unit at the price it was recorded at, once, and the vendor receives all of them. | `Subscription/PeriodCloseUsage.policy.ts` (`billableLines`), `Subscription/Entitlements.view.ts` (`priced`), `Subscription/TrackUsage.command.ts` (`UsageRecorded.billable`), `Subscription/Subscription.state.ts` (`billableUnitsOf`), the outbox in `Store/SqlAggregateStore.ts` |
| `PaykitCreditClose` | A close returns the plan's credits or applies the scheduled grant, keeps the pack, and open holds stay covered by the pool. | `Subscription/Subscription.aggregate.ts` (`Hold`, `SettleHold`, `closePeriodEvents`), `Subscription/Subscription.state.ts`, `Subscription/ScheduleTierChange.command.ts`, `Catalog.ts` (`CatalogCreditFeatureHasAllowance`) |
| `PaykitAutoTopUp` | A crossing buys one pack even when the policy runs again, and two crossings never share a command id. | `Subscription/AutoTopUp.policy.ts` (`crossedThreshold`, `topUpCommandId`, `AutoTopUpLive`), `Subscription/Subscription.state.ts` (`topUpOf`), `Tier.ts` (`TopUpThreshold`), `Subscription/PurchaseCredits.command.ts`, `Store/SqlAggregateStore.ts` (`send` receipt dedupe) |

## The invariants that carry the weight

`PaykitStore`

- **`StateIsFoldOfLog`** — `pool` equals the log's fold. Everything a read model
  rebuilds, and every "the log is the record" claim, is this equality.
- **`NeverOverdrawn`** — no prefix of the log spends more than the pool held. A
  pool below zero is a state no read can explain.
- **`VersionCountsEvents`** — the version and the log agree on how many events
  there are.

`PaykitReportSplit`

- **`SplitConservesBillable`** — the units the events recorded per price add up
  to what the period would have reported in one number. `UsageRecorded.billable`
  is computed against the running total when the event is recorded; the close
  only sums it, so a changed standing cannot reprice the units already taken.
  The free grant belongs to the period, not to the price: charging it per price
  gives the same grant away once per price and the total stops matching the
  usage.
- **`ReportNamesEveryPrice`** — the meter never holds a number the period did
  not close with, at any price. `PushThenCrash` is a push that lands and a
  process that dies before the outbox marks the delivery done; the redelivery is
  the same payload, so the number it wrote was already the right one.
- **`EveryBillableUnitArrived`** — once the outbox has drained, every price the
  period billed for is at the meter. One lost line is one unbilled unit.
- **`NoReportWithoutClose`** — the vendor never hears about a period the
  aggregate did not close.

`PaykitCreditClose`

- **`PrepaidWithinPool`** — `0 <= prepaidCredits <= credits`, the invariant the
  state file states in a comment.
- **`HoldsAreCovered`** — what open holds reserved is still in the pool to pay
  them with, so `availableOf` never answers below zero.
- **`CloseAppliedTheScheduledCredits`** — the grant scheduled for the boundary
  is in the pool next to the pack the close carried through. A close that
  ignores the schedule leaves the new tier's credits behind; a close that drops
  the pack leaves `prepaid` out of the same sum.
- **`CloseExpiresOnlyWithoutChange`** — with no schedule, a close returns only
  the plan's own credits; a pack is not part of the expiring grant. This is the
  pack's check on the no-change path.

`PaykitAutoTopUp`

- **`AtMostOnePurchasePerCrossing`** — a delivery and its redelivery are the
  same command id, so a second pass is a receipt the store already has, not a
  second pack.
- **`EveryProcessedCrossingHasItsPack`** — a command id shared by two crossings
  makes the second one a duplicate of the first and its credits never arrive.
  A key that names the crossing is what keeps the two apart.
- **`LateDeliveriesOpenNoInvoice`** — a delivery after the pool recovered opens
  nothing. The balance check is what keeps a late delivery from buying a pack
  the account no longer needs.

## A model that has never failed is a model nobody has tested

Each model carries the constants that decide whether it describes the good
design or a broken one. Flipping one must produce a counterexample; if it does
not, the invariant above it is not load-bearing and should be rewritten or
deleted.

```sh
# PaykitStore: append a decision without checking the version it was made on
sed 's/ChecksVersion = TRUE/ChecksVersion = FALSE/' spec/PaykitStore.cfg > /tmp/stale.cfg
# PaykitReportSplit: grant the free units once per price, not once per period
sed 's/SharesIncluded = TRUE/SharesIncluded = FALSE/' spec/PaykitReportSplit.cfg > /tmp/free.cfg
# PaykitCreditClose: let an open hold survive the close, which the catalog forbids
sed 's/KeepsHolds = FALSE/KeepsHolds = TRUE/' spec/PaykitCreditClose.cfg > /tmp/kept.cfg
# PaykitCreditClose: ignore the tier change scheduled for the boundary
sed 's/AppliesScheduledGrant = TRUE/AppliesScheduledGrant = FALSE/' spec/PaykitCreditClose.cfg > /tmp/applied.cfg
# PaykitAutoTopUp: key each attempt instead of the crossing
sed 's/StableKey = TRUE/StableKey = FALSE/' spec/PaykitAutoTopUp.cfg > /tmp/attempt.cfg
# PaykitAutoTopUp: key every crossing with the same command id
sed 's/DistinctKeys = TRUE/DistinctKeys = FALSE/' spec/PaykitAutoTopUp.cfg > /tmp/shared.cfg
# PaykitAutoTopUp: buy on a delivery whose pool already recovered
sed 's/ChecksRecovered = TRUE/ChecksRecovered = FALSE/' spec/PaykitAutoTopUp.cfg > /tmp/recovered.cfg
```

Every one of them produces a trace today: `StateIsFoldOfLog`,
`SplitConservesBillable`, `HoldsAreCovered`, `CloseAppliedTheScheduledCredits`,
`AtMostOnePurchasePerCrossing`, `EveryProcessedCrossingHasItsPack`, and
`LateDeliveriesOpenNoInvoice`. The store one models what the code did before
the fix described below, so it stays as the test of the invariant rather than
as dead history.

## What the model does not cover

- **`decide` arithmetic.** It is pure and single-threaded, and
  `packages/paykit/test/{properties,stories,conformance}` already own it.
  Modelling numbers a test already pins is sunk cost; the model is for the
  interleavings around them. `PaykitReportSplit` likewise keeps the grant
  constant: a mid-period tier change that moves `included` is arithmetic, not an
  interleaving, and `billableUnitsOf` is what the tests pin.
- **The vendor.** Anything about what Stripe or Polar actually does belongs in
  the gated live tests. The model checks paykit's side of the contract.
- **The timeline fold.** `Timeline.ts` is a pure fold over an ordered stream;
  `lastSeq` makes a redelivered event a no-op. `test/timeline/Timeline.test.ts`
  owns it, and a model here would be a second implementation of one comparison.
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
transaction", and the append read `MAX(seq)` and wrote over it without a lock or
an expected version. `SqlExecutor.lock(account)` — "take the per-account write
lock for the current transaction" — had no caller anywhere in the repo.

Reproduced against the shipped SQLite driver: a pool of 100, two concurrent
spends of 60, both accepted. The log folded to `-20` while the state row said
`40`.

```
log: 0 + 60 + 60
fold of log: -20
published pool: 40
```

Closed by the `ChecksVersion` arm the model already carried: `append` claims and
locks the instance's state row, reads `MAX(seq)` under that lock, and compares it
to the `expectedVersion` the decision was made on, answering `conflict` instead
of writing when the log has moved. `send` re-reads and re-decides — bounded at
32 attempts, because `decide` is pure and a retry is the same command over a
state that moved, not a second effect.

The trace is the test: `test/sql/AggregateStore.test.ts`, "re-decides a command
instead of publishing a state its log cannot explain", runs both spends against
a gate inside `handle` so both reads land before either append. Remove
`expectedVersion` from `send` and it fails.

`ChecksVersion = FALSE` still models the old behaviour, which is what that test
would catch if the check ever went away.

## The models the queue needed

`PaykitReportSplit`, `PaykitCreditClose` and `PaykitAutoTopUp` did not find a
bug. They settled a design and pinned a rule, which is the other half of what a
spec is for.

### Splitting a period's report by price

`PaykitReportSplit` is the close after
[ADR 0008](../docs/adr/0008-a-report-names-the-price-each-unit-was-recorded-at.md):
one report per period, carrying a line per price. The model that preceded it —
one quantity per period, priced at whatever the standing said when the close ran
— was deleted when the split landed, because a model of a replaced design is a
gate on nothing.

**The free grant belongs to the period.** `Included` is units a period gives
away, so with two prices it is still one grant. The model keeps the grant
constant and freezes the period's billable units per price; that is the closed
form of summing the `billable` on each event. The arithmetic is
`billableUnitsOf`'s, and the tests own it.

```tla
SplitConservesBillable ==
  \A p \in closed : frozen[p][1] + frozen[p][2] = Billable(recorded[p])
```

Any allocation rule passes that invariant as long as it is an allocation; the
one the model uses is the simplest that consumes the grant once. Charging
`Included` per price (`SharesIncluded = FALSE`) is what fails, because it makes
the period give the grant away twice. A tier change that also moves `included`
mid-period is arithmetic a test owns, so the grant stays constant here.

**One report, not one per price.** The first version of this model put a report
per `(period, price)` in the outbox, keyed by a price-qualified command id. That
works, and it is what a vendor meter suggests, but it moves the idempotency
guarantee from "the payload is a function of the period" to "the key is a
function of the period and the price" — and a caller that forgets the second
half gets a silent loss, because the second report dedupes into the first and
its units never arrive. The code took the other shape: one report per period
whose payload is the split. Redelivery is then the same payload by construction,
which is what `ReportNamesEveryPrice` checks.

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

### Applying the grant scheduled for the boundary

[ADR 0012](../docs/adr/0012-a-tier-change-can-be-scheduled-for-the-boundary.md) makes a tier
change schedulable. The close applies it before the reset, and the pool it
leaves is the new tier's credits plus whatever one-off pack the account still
holds — the old grant is replaced, not expired. `scheduled` is that grant; the
close leaves it on the state as the record of what it applied.

`AppliesScheduledGrant = FALSE` is the design that ignores the schedule: the
close takes the no-change path, expires the old grant, and
`CloseAppliedTheScheduledCredits` fails. The pack is part of the same
invariant, because the expected pool is `scheduled + prepaid`; with no schedule
`CloseExpiresOnlyWithoutChange` is the pack check.

### One pack per crossing

`PaykitAutoTopUp` is [ADR 0013](../docs/adr/0013-an-auto-top-up-is-a-purchase-on-a-crossing.md),
with the threshold as a tier field after
[ADR 0016](../docs/adr/0016-a-top-up-threshold-is-a-tier-field.md). The policy
reads the standing's `topUp` line; a tier without one never refills. It keys the
invoice and the `PurchaseCredits` command by `topup:<account>:<event seq>`, and
the store dedupes by that command id. `StableKey` is the crossing as the key;
`DistinctKeys` is what keeps two crossings from sharing one. The model holds
the line constant; a tier change moves it for the next spend, which is catalog
arithmetic rather than an interleaving.

`StableKey = FALSE` makes every delivery a new key, so a redelivery buys again
and `AtMostOnePurchasePerCrossing` fails. `DistinctKeys = FALSE` makes every
crossing share one key, so the second purchase is deduped into the first and
`EveryProcessedCrossingHasItsPack` fails with a crossing that recorded no pack.
`React` and `Record` are separate actions, so a crash between the invoice and
the purchase is a reachable state; a retry reuses the key.

`ChecksRecovered` is the late-delivery guard. With it off, a delivery that
arrives after a grant has lifted the pool opens an invoice for a need that is
gone, and `LateDeliveriesOpenNoInvoice` fails. With it on, the same delivery is
`Skip`, which records that it was seen and buys nothing.

## Counterexamples become tests

A trace is a list of steps with the exact state at each one: `Read(w2)`, `Commit(w1)`,
`Commit(w2)`. That sequence is a test — two fibers, one store, a latch inside
`handle` so both reads land before either append. When a model finds something,
the trace is the test's setup, and the model's invariant is the assertion. That
is the loop: model finds it, test pins it, the bug cannot come back.
