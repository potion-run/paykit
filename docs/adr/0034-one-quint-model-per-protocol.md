# 0034 — One Quint model per protocol, and a coverage table that keeps it honest

- **Status:** Accepted
- **Date:** 2026-11-09
- **Follows:** [0004](./0004-a-hold-is-one-call-and-an-id.md), [0009](./0009-only-a-blocking-allowance-refuses-a-move-below-its-usage.md), [0021](./0021-hold-expiry-is-a-state.md)

## Context

`src/Subscription` holds 35 commands, one aggregate, and one set of counters. Every refusal that
matters is a statement about those counters — a hold reserves from the same pool a spend draws on, a
period reset rewrites `remaining` under open holds, a cancellation has to leave a hold closable — so
the interesting properties are cross-command by construction.

The property suite already samples the state machine: `test/properties/Arbitraries.ts` generates a
script of up to 80 steps and `walk` folds it through `decide`/`evolve`. That is a **sequential** fold.
A policy fires only when a script step names it, so the suite never interleaves a sweep with a settle,
never races two holds against one spend, and never checks a schedule. It samples 100 runs.

An earlier pass modelled four of these concerns in TLA+ (`spec/PaykitStore`, `PaykitReportSplit`,
`PaykitCreditClose`, `PaykitAutoTopUp`, checked by `scripts/check-spec.ts` through `tla-ts`) and was
removed in `a62fc1b`. It was the right instinct with the wrong unit: four models of one
state machine, each re-declaring the counters it needed, none of them able to state the conservation
that ties a hold to a spend to the pool. `PaykitStore` still earned its keep — it found a version
check missing from `SqlAggregateStore.send` — and the practice worth keeping is that a model which has
never been made to fail is a model nobody has tested.

Quint is executable, so a model can be simulated on every pull request without a JVM, and it is
authored in modules with witnesses and named tests, so it can be gated the way the rest of this repo
is gated.

## Decision

**1. The unit of specification is a protocol, not a module and not a command.** `specs/paykit`
models the aggregate's spend path as one machine: activation, counted usage, credit usage, holds,
the pool, the standing, and the clock. A spec per file would be 35 partial models of one state, none
of which could state the conservation that makes the others meaningful.

**2. The model is smaller than the code, and derived where the state is a cache.** Three features, one
account, `int` credits, a step counter instead of a clock. A credit-priced feature's `remaining` is
derived (`spendableOf`) rather than stored, because the aggregate's stored copy is a cache that
`ConsumeCredits` leaves stale and that nothing observable reads. Where the *log* is the truth and the
state has no field, the model keeps a history variable: `consumed` exists because the pool's
conservation law includes what `ConsumeCredits` spent, and `CreditsConsumed` is the only record of it.

**3. A refusal is a disabled action.** `quint` never reports a rejection tag, so the model checks the
accept-set, and a `run` in `paykit_test.qnt` checks each refusal that matters. The two check different
things on purpose: dropping the "a terminal standing may not settle" guard conserves every counter, so
only the named test catches it.

**4. `scripts/spec-coverage.ts` is the drift gate, in the shape of `STANDING_PHASE_TRANSITIONS` and
its test.** The table names, for every `*.command.ts`, either the action that models it or why it is
out of the slice. The gate fails in all four directions: an unclassified command, a row for a command
that no longer exists, a row naming an action the model does not define, and an action the table does
not account for. A command cannot land unsorted, and an action cannot be dropped silently.

**5. `quint run` is a gate; `quint verify` is not.** Simulation is seconds and needs no JVM, so
`pnpm spec` runs on every push beside `pnpm test`. Apalache needs a JVM and minutes, so it stays a
manual run for a specific property, recorded in `specs/paykit/README.md` when it happens. The same
split as `check.yml` and `live.yml`: a gate that needs an external toolchain is not in the path of a
pull request.

**6. `scripts/spec-mutants.ts` proves the invariants are load-bearing.** An invariant can hold because
nothing in the model can move the counter it watches. The gate inverts one rule at a time — a settle
that keeps what it did not bill, a hold that reserves nothing, a release on a settled hold, a clock
that passes a deadline — and fails when a mutant *survives*. This is the TLA+ era's "flip a constant
and watch the invariant fire", made mechanical and required.

**7. `specs/` is a root directory, not a workspace package.** No export map, no `lib/`, no version,
nothing for `exports:check` or `validate:publish-packages` to read. `oxfmt` ignores it — Quint 0.33
ships no formatter — and the root `tsconfig.json` excludes it.

## Consequences

- `pnpm spec`, `pnpm spec:coverage` and `pnpm spec:test` run in `check.yml` after `pnpm lint`. Ten
  seconds, ten thousand traces, every invariant, and 21 named scenarios.
- The seven invariants are load-bearing rather than decorative: nine mutants break one rule each, and
  every one is killed by the invariant named beside it. Adding an invariant without a mutant is a
  claim with nothing behind it.
- The model surfaced two facts that were not written down: a credit-priced feature's stored
  `remaining` is stale after `ConsumeCredits` (harmless — `availableOf` and `withPool` both compute
  from the pool), and the pool has no counter for a direct consume. Both are recorded in
  `specs/paykit/README.md` instead of being fixed, because neither changes an observable answer.
- Adding a command now costs one row in `SPEC_COVERAGE`, and that row is a decision: model it, or say
  why this slice does not.
- The period close will make the conservation law period-scoped (`carried` is the second base), which
  is the next slice rather than a hole in this one.

## Alternatives considered

- **One spec per module.** Rejected: the state is one record, and 35 models of it would duplicate the
  counters, drift from each other, and still not state cross-command conservation.
- **Signatures under `packages/paykit/src`.** Rejected: the package's export map and the two manifest
  gates read `src/`, so a model there is either a published module or an exception in three places.
- **TLA+ directly.** Rejected: no simulator, no test runner, no witnesses, and every change needs the
  toolchain that the run gate exists to avoid.
- **Only the property suite.** Rejected: it walks one sequential script. The interleavings the model
  names — a sweep against a settle, a cancellation against an open hold — are exactly what a fold
  cannot produce.
- **The four TLA+ models, ported.** Rejected for the reason above: they are four partial models of one
  machine. `PaykitStore`'s version check is the one worth re-modelling, and it belongs to the store
  protocol rather than to the aggregate — its own spec if it comes back.
- **`quint verify` on every push.** Rejected: minutes and a JVM for a bound that the sampled run
  already covers at the sizes this model uses.

## What would reopen this

- A second protocol with its own state and its own invariant: the vendor lifecycle
  (`BillingStack`, `StripePrices`, `PolarPrices`) is the candidate, and it would be
  `specs/provisioning` rather than more actions in `specs/paykit`.
- A model that grows past one screen per section: split `specs/paykit` into Quint modules
  (`state`, `usage`, `holds`, `credits`) that the machine imports.
- A property the simulation cannot reach at 40 steps. Either the bound or the abstraction is wrong,
  and `README.md` says which mutation was used to prove the invariant is not vacuous.
