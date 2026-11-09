# The paykit model

A Quint model of the `Subscription` aggregate's spend path: what a period includes, what a usage
fact may record, what a hold reserves, and what the credit pool can cover.

```sh
pnpm spec          # typecheck both modules, then simulate with every invariant
pnpm spec:test     # the named scenarios in paykit_test.qnt
pnpm spec:mutants  # break one rule at a time and prove an invariant notices
pnpm spec:coverage # hold this model's table against every command
```

One spec per **protocol**, not one per file. There are 36 commands in `src/Subscription`; they are
one state machine with one set of counters, and the bugs worth a model are the ones that cross
commands — a hold's reservation against a credit spend, a release against a settle, a deadline
against a cancellation. A spec per command would be 36 partial models of the same state, none of
which could state those. `scripts/spec-coverage.ts` keeps the list below honest as commands land.

## Run it

`quint run` samples traces; it does not prove. A green run means "no violation in 10 000 walks of up
to 40 steps", which is a different claim from the property suite's 100 walks of up to 80 sequential
steps: this one lets the clock, the sweep and a command interleave freely, and the property suite
never does.

`quint verify` (Apalache) is not wired to a gate. It needs a JVM and minutes, and the shared modelling
discipline is to reach for it only when someone asks to model-check a specific property. When that
happens, run it by hand and record the command and the bound in this file.

## What it models

| Action | Source | Event it records |
| --- | --- | --- |
| `subscribe` | `Subscribe.command.ts` | `SubscriptionActivated` |
| `trackUsage` | `TrackUsage.command.ts` | `UsageRecorded` |
| `consumeCredits` | `ConsumeCredits.command.ts` | `CreditsConsumed` |
| `hold` | `Hold.command.ts` | `UsageReserved` |
| `settleHold` | `SettleHold.command.ts` | `UsageRecorded` + `UsageSettled` |
| `releaseHold` | `ReleaseHold.command.ts` | `UsageReleased`, reason `released` |
| `expireHold` | `HoldElapsed.command.ts` | `UsageReleased`, reason `expired` |
| `enterGrace` | `EnterGrace.command.ts` | `GraceEntered` |
| `recover` | `Recover.command.ts` | `Recovered` |
| `cancelStanding` | `ScheduleCancellation.command.ts`, `Expire.command.ts` | `CancellationScheduled`, `SubscriptionExpired` |
| `tick` | the platform clock the policy scheduler runs on | — |

A refusal is a **disabled action**: `quint` never reports a rejection tag, so `paykit.qnt` checks
the accept-set and `paykit_test.qnt` checks that the refusal holds. Every action has a witness in
`paykit.qnt` and a `run` in `paykit_test.qnt`, so an action that stops being reachable fails the
gate instead of quietly staying green.

## The invariants

| Invariant | What it says | ADR |
| --- | --- | --- |
| `countedConserved` | `remaining + used + reserved == included`, for every counted feature | 0004, 0009 |
| `noNegativeUsage` | usage only moves forward | 0008 |
| `blockingNeverOversubscribed` | a `block` allowance's remaining never goes below zero; `bill` may pass `included` | 0009 |
| `creditsCoverEveryHold` | the pool covers every open hold, so settle always has credits to bill | 0002, 0004 |
| `creditPoolConserved` | `credits + spent + consumed == granted` | 0002 |
| `holdCostIsAmountTimesRate` | a hold's reservation is its units times the rate it captured | 0004 |
| `noHoldPastDeadline` | the clock never passes an open hold's deadline | 0021 |

Each is load-bearing, not decorative, and `pnpm spec:mutants` is what proves it. An invariant can be
true because nothing in the model can move the counter it watches, so the gate inverts one rule at a
time and fails when a mutant **survives**:

| Mutant | What it gets wrong | Invariant that kills it |
| --- | --- | --- |
| `settle-drops-the-return` | a settle keeps the units it did not bill | `countedConserved` |
| `hold-reserves-nothing` | a hold leaves what it reserved spendable | `countedConserved` |
| `settle-a-closed-hold` | a settle bills a hold somebody released | `countedConserved` |
| `release-a-settled-hold` | a release returns units a settle already billed | `countedConserved` |
| `consume-forgets-the-history` | a direct consume the pool's law cannot see | `creditPoolConserved` |
| `credit-spend-keeps-the-credits` | usage that spends no credits | `creditPoolConserved` |
| `hold-cost-ignores-the-rate` | a hold that reserves units where the pool charges credits | `holdCostIsAmountTimesRate` |
| `tick-passes-the-deadline` | a clock that walks past a deadline with a hold open | `noHoldPastDeadline` |
| `blocking-allows-past-remaining` | a blocking allowance that accepts more than it has | `blockingNeverOversubscribed` |

A mutant is a textual replacement, and the gate insists the anchor occurs exactly once: rename a rule
and it reports a stale mutant instead of mutating the wrong line. Adding an invariant without a mutant
is a claim with nothing behind it — add the mutant in the same change.

One rule is **not** an invariant: "a terminal standing may not settle". It conserves every counter,
so only `cancelRefusesSettleTest` catches it — the two halves check different things on purpose.

## What it does not reproduce

- **Tiers, proration, dunning, top-up, payment, quantities, flags, `unlimited`, caps, money caps,
  dedupe keys, currency.** The model's three features are a blocking count, a billing count and a
  credit-priced feature, with one scope and one rate. Money ceilings and banded prices are
  `Pricing.test.ts`'s job; modelling the arithmetic here would only make the model wrong in a new way.
- **Period close and rollover.** With no reset, `remaining + used + reserved == included` holds for
  the whole life of a standing, which is the cleanest form of the conservation law. A close adds
  `carried` and a second base; it belongs in the next slice, with an invariant that says the new
  base is the old one plus what the close granted.
- **The read model.** `Entitlements`, `BillingState`, and every projection are folds over the same
  events and are compared against the aggregate by `test/properties/Agreement.test.ts`.
- **Idempotence.** A retried command is a no-op; `Idempotence.test.ts` and the command ids carry it.

### The one finding

`state.remaining[feature]` for a credit-priced feature is a **cache**, not a fold. `TrackUsage`,
`Hold`, `SettleHold` and `ReleaseHold` recompute it, but `ConsumeCredits` lowers `credits` and
leaves the feature's stored `remaining` where it was. Nothing observable reads the stale value —
`availableOf` and the read model's `withPool` both compute from the pool — so this is a cache that
is briefly behind, not a bug. The model therefore **derives** a credit-priced feature's remaining
(`spendableOf`) instead of storing it: an invariant over a field nothing reads would only be able to
fail for the wrong reason.

Two things follow. `ConsumeCredits` names no feature, so the aggregate has no counter for what it
spent; the model keeps `consumed` as a history variable because the pool's conservation law needs
it. And the model's `credits + spent + consumed` law is a claim about `CreditsConsumed` events, not
about a field.

## When to update it

The spec is the ground truth for the seven invariants above and for nothing else. When a command in
the table changes what it accepts or what it writes, update the model and re-run `pnpm spec` **before**
changing the command — a red model is a cheaper place to find out than a red deploy. When a new
command touches `remaining`, `used`, `credits`, or `holds`, it is in scope: add the action, its
witness, its `run`, and either an invariant or a note here saying why it has none.

The next slice is the period close, then the quantity (seat) path — see
[`docs/NEXT.md`](../../docs/NEXT.md).
