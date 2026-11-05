# spec

TLA+ models of the parts of paykit that no test can reach: two writers on one
account, a scheduled command that fires while a caller does something else, an
outbox that redelivers, and a process that dies between the push and the record
of it. A test walks one thread through time; a model checker walks every
interleaving and stops at the first one that breaks a rule.

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
```

Both produce `ReportedQuantityIsClosing` / `StateIsFoldOfLog` traces today. The
second models what this store did before the fix described below, so it stays as
the test of the invariant rather than as dead history.

## What the model does not cover

- **`decide` arithmetic.** It is pure and single-threaded, and
  `packages/paykit/test/{properties,stories,conformance}` already own it.
  Modelling numbers a test already pins is sunk cost; the model is for the
  interleavings around them.
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

## Counterexamples become tests

A trace is a list of steps with the exact state at each one: `Read(w2)`, `Commit(w1)`,
`Commit(w2)`. That sequence is a test — two fibers, one store, a latch inside
`handle` so both reads land before either append. When a model finds something,
the trace is the test's setup, and the model's invariant is the assertion. That
is the loop: model finds it, test pins it, the bug cannot come back.
