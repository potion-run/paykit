# 0031 — A failed top-up retries on a budget, not a cooldown

- **Status:** Accepted
- **Date:** 2026-11-08
- **Follows:** [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md), [0016](./0016-a-top-up-threshold-is-a-tier-field.md), [0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md), [0025](./0025-a-dunning-ladder-is-a-scheduled-retry.md), [0026](./0026-a-tier-states-its-whole-top-up-line.md), [0027](./0027-a-failed-top-up-is-a-fact-in-the-log.md)

## Context

[ADR 0027](./0027-a-failed-top-up-is-a-fact-in-the-log.md) made a failed refill a fact: `TopUpFailed`
records the pack, the price, the provider's reason, and the standing carries it as `topUpFailure`. It
ends by saying the cooldown the crossing opened is what retries it. **It is not.** The policy schedules
`TopUpCooldownElapsed` before the purchase, but the standing records `topUpCooldownUntil` inside
`PurchaseCredits`, which on this path never runs. So the deadline arrives, `decide` finds no cooldown,
and answers `[]`. The failure is recorded and then abandoned.

That would be survivable if the next spend could try again. It cannot: `crossedThreshold` is true only
when the pool was *above* the line and fell to or below it. A pool already under the line does not
cross on the next spend, so an account whose card expired is stuck until the period resets its grant
or an operator grants credits by hand. The log says why; nothing acts on it.

[ADR 0025](./0025-a-dunning-ladder-is-a-scheduled-retry.md) already built the shape a retry needs — a
scheduled command that `decide`s from the standing, guards its own staleness, and records the attempt.
This is the same machine with a different budget.

## Decision

**1. The budget is the line's, and it is opt-in.** `Tier.topUp` gains `retry`:

```ts
topUp: { threshold: 5_000, cooldown: Duration.hours(1), pack: "credits_100k",
         retry: { attempts: 3, every: Duration.hours(6) } }
```

`attempts` counts retries **after** the first attempt, so `3` is four provider calls at most. Absent,
nothing changes: a failed refill is recorded and left alone, which is what every catalog states
today. It belongs on the tier rather than on `Paykit.autoTopUp` for the reason ADR 0026 gives — the
line is the tier's, and a free tier and an enterprise tier do not run the same refund policy.

**2. The standing counts consecutive failures.** `topUpAttempts` is `0` on a new standing and moves
only on `TopUpFailed`, which carries the `attempt` it became. A counter that a replay must reproduce
belongs in state, not in a policy's memory.

**3. A retry is a scheduled command, not a timer.** On failure, while the budget allows, the policy
schedules `RetryTopUp { attempt }` at the failure's own `at` plus `every` — the failure's time, not
the policy's clock, so a redelivery schedules the same deadline. `decide` records `TopUpRetryDue` only
while **all** of these hold:

- the standing is still `Subscribed`, and still states a line;
- the pool is still at or below the line — a retry for a pool that recovered is pointless;
- no cooldown is open, because a cooldown defers to its own deadline;
- `topUpAttempts` still equals `attempt`, which is how a success or a newer failure makes a stale
  deadline a no-op.

Anything else records nothing. A card fixed after two failures therefore cannot be charged four
times by an old schedule: the first success resets the counter and every outstanding rung is stale.

**4. The policy treats a retry as its own trigger.** `AutoTopUp` reacts to `TopUpRetryDue` as well as
the two spends and the cooldown, with `due` being "the pool is still at or below the line" — the same
test `TopUpCooldownCleared` already uses, because a retry is a crossing that already happened.

**5. The counter resets on what ends an episode, and the record does not.** A successful
`CreditsPurchased` clears `topUpAttempts` (the refill that was owed landed), and so do
`SubscriptionActivated`, `TierChanged` and `PeriodClosed`, because each re-establishes the line or
the pool — a fresh line with a new pool deserves a fresh budget, or a failure from last period would
suppress the retries this one is owed. `topUpFailure` is *not* cleared by those: it is the record of
what happened, and ADR 0027's "a failure survives a tier change" is a statement about history. Only
a purchase makes good on it.

A pool that recovers and crosses again *without* a purchase keeps the count: a grant that lifts the
pool and a spend that drops it again is a new crossing, but treating it as a new episode would let a
deployment's own topping-up loop a card forever. Erring toward fewer retries is the safe direction.

**6. Missing capability is still a tag, never a retry.** A provider that declares neither `charge` nor
`invoice` is a deployment error and dies at boot, exactly as ADR 0018 says. The budget is for a
provider that was asked and refused.

**7. The page says which attempt it is on.** `BillingState` carries `topUpAttempts` beside
`topUpFailure`, so an operator reads "refill failed twice, 1 attempt left" rather than inferring it
from the log.

## Consequences

- An account whose card was briefly declined recovers without an operator. That is the whole point:
  the failure was already recorded, and the only thing missing was someone to try again.
- A permanently declined card costs `attempts + 1` provider calls per episode and then stops, and the
  log has one `TopUpFailed` per call with the provider's reason on each.
- A deployment that wants paging on consecutive failures already has the material: `topUpAttempts`
  and the failure's `at` are both in the read model.
- The retry's purchase gets its own command id (the retry event's sequence), so it is a new attempt
  and a new provider call rather than a replay of the failed one. The failure it may produce is keyed
  the same way, so each attempt records at most one failure.
- `every` is a flat interval, not a ladder. [ADR 0025](./0025-a-dunning-ladder-is-a-scheduled-retry.md)
  chose a ladder for dunning because grace is a fixed window and the rungs are the attempts it holds;
  a top-up has no deadline, so the rungs would be a schedule nothing reads.

## Alternatives considered

- **Retry at the cooldown.** It reads like reuse and it conflates two questions: the cooldown bounds
  how often a *successful* refill may charge, and the budget bounds how often a *failed* one may be
  retried. A deployment that wants one pack an hour and three retries a day cannot say both with one
  field.
- **A `topUpFailures` count with no deadline.** Nothing would act on it. The counter exists to make a
  scheduled command answer "is this rung still mine", not to be read.
- **Retry until the pool recovers.** An expired card is not a transient condition, and an unbounded
  loop against a provider is how an account gets locked out.
- **Have `decide` refuse to let the pool stay under the line.** `decide` may not call a provider, and
  a standing that refuses usage because a refill failed would take the service away over a billing
  attempt.

## What would reopen this

- A backoff ladder per tier, if deployments want `[1h, 6h, 1d]` rather than a flat `every`.
- A provider that can be asked to retry its own invoice: a new port operation, and a budget expressed
  in that vendor's schedule rather than in paykit's.
- Failure-kind-aware retries: a transport timeout is worth retrying immediately and a `card_declined`
  is not, which would make the budget read `reason` — a change to what ADR 0027 records, and the
  first time `decide` would read a provider's vocabulary.
