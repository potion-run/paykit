# 0017 — A top-up cooldown is a deadline on the standing

- **Status:** Accepted
- **Date:** 2026-11-06
- **Follows:** [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md), [0016](./0016-a-top-up-threshold-is-a-tier-field.md)

## Context

[ADR 0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) made the pack its own cooldown: buying
lifts the pool above the line, so the next crossing costs at least a pack. That argument holds for a
customer whose spend is roughly steady, and fails for one whose spend is not. A pack bought at 09:00 and
burned by 09:05 puts the pool above the line and back below it inside the same minute, and the crossing
rule buys again — as many times as the customer can cross. Nothing in the standing says "a refill just
happened"; the event log says it, and a policy that wanted to refuse would have to read the log's clock.

ADR 0013 rejected a time cooldown for two reasons: it needs a timer command, and it "would refuse a
genuine refill for a reason the customer cannot see". Both are answerable, and the second is answerable
without refusing anything. ADRs
[0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) and
[0016](./0016-a-top-up-threshold-is-a-tier-field.md) both name this as the next decision, so this is
that decision, not a reversal.

The deadline machinery already exists and is not new: `UsageReserved` carries an `expiresAt`,
`HoldSweep` schedules `HoldElapsed` from it, and `decide` reads the clock from its command context, past
the deadline acts, and before it records nothing. `PeriodEnded` and `GraceElapsed` are the same shape. A
cooldown is one more deadline of that kind.

## Decision

**1. `cooldown` is a deployment option, and it is optional.** `Paykit.autoTopUp({ catalog, pack,
cooldown })` takes an `effect/Duration`. Without it nothing changes: the pack is the bound, exactly as
[ADR 0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) decided. With it, one top-up buys per
cooldown for the whole deployment, because it is a spend-rate bound on the deployment's money, not a
property of a tier's prices. A per-tier cooldown would be a later field on `Tier.topUp`, and the
argument for it is the same one [ADR 0016](./0016-a-top-up-threshold-is-a-tier-field.md) made for the
threshold.

**2. The deadline is recorded, because it is part of what happened.** A policy-opened purchase carries
`cooldownUntil`; `CreditsPurchased` records it; the standing holds `topUpCooldownUntil`. This is the
same route `expiresAt` takes on a hold: a number the deployment decides is written into the event that
records the purchase, so a replay reproduces the standing exactly and a catalog change cannot move a
deadline that was already sold. `decide` never reads a clock to decide whether a cooldown is open; it
reads the field.

A purchase a webhook reports — a buyer completing a checkout — carries no cooldown. The cooldown is the
auto top-up's own bound on spending the deployment's money, not a rule imposed on a customer who chose
to buy.

**3. The cooldown ends with a scheduled command, not a timer.** After a purchase the policy schedules
`TopUpCooldownElapsed` at `cooldownUntil`, keyed by the crossing, the same way `HoldSweep` schedules
`HoldElapsed`. The deadline is measured from the crossing event's own commit time, which the log
already carries: a policy that read a clock would answer differently on a redelivery. The command
never rejects: before the deadline, or with no cooldown on the standing, it records nothing; at or
after it, it records `TopUpCooldownCleared`, which clears the field.

The schedule is written before the purchase command, so a crash between the two leaves a deadline that
fires against a standing with no cooldown — a no-op — rather than a cooldown nothing clears. A lost
schedule is a standing that cannot refill again, which `BillingState.topUpCooldownUntil` makes visible
on the page an operator is already reading; it is not a silent second purchase.

**4. A crossing during a cooldown is deferred, not refused.** The suppressed crossing is not forgotten:
the event that clears the cooldown is itself an input to the policy, and when it arrives the policy asks
one question — is the pool still at or below the standing's line? — and buys if it is. That is the
answer to [ADR 0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md)'s objection: the refill is
delayed to the first moment the deployment allows, rather than dropped for a reason the customer cannot
see. A pool that recovered above the line in the meantime is not a crossing and buys nothing, which is
the same rule the policy already applies to a late redelivery.

The cleared event's purchase is keyed by the cleared event's own sequence, so it is a different invoice
from the one the cooldown followed, and a redelivery of the cleared event is the same one.

**5. The bound is one pack per cooldown, even while the pool stays low.** If a pack is smaller than the
deficit, the cleared deadline buys again and starts a new cooldown. That is the intent of a spend-rate
bound: it does not promise the customer a pool, it promises the deployment a ceiling on how fast it can
be charged. A deployment that wants a different ceiling changes the cooldown or the pack; a deployment
that wants a stop entirely is a `TopUpFailed` decision with dunning behind it, which ADR
[0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) already named as its own slice.

**6. The standing's page carries the deadline.** `BillingState.topUpCooldownUntil` is set by
`CreditsPurchased` and cleared by `TopUpCooldownCleared`, so "on pro, refilling below 5,000 credits,
next refill allowed at 09:30" is one sentence an operator can read without opening the log.

## Consequences

- **A deployment that sets no cooldown is byte-for-byte unchanged.** No field on the event, no scheduled
  command, no new read-model value.
- **The cooldown is per account, not per deployment-wide budget.** Two accounts that cross at the same
  moment both buy; the cooldown bounds one account's refill rate. A deployment-wide budget is a
  different number with a different owner.
- **A standing that is closed while a cooldown is open keeps the field** until the deadline fires; the
  command clears it on whatever state the account is in, and records nothing if the field is absent.
- **The event log grows one event per top-up.** That is the cost of a deadline that is replayable, and
  it is the same cost `HoldElapsed` and `PeriodEnded` already pay.
- **A policy that buys nothing is still a policy.** A deployment that names a cooldown but whose tiers
  never state `topUp` schedules nothing, because it buys nothing.

## Alternatives considered

- **Compare `now` to the purchase's `at` inside the policy, with no state and no command.** One clock
  read, no event, no migration. Rejected: the recorded decision would depend on when the policy happened
  to run rather than on what the deployment decided, and a redelivery would answer differently from the
  first delivery — the same reason `HoldElapsed` is a command.
- **Block with a `cooldownMs` counter on the layered config and let the policy sleep.** A policy that
  sleeps holds a stream, and there is still nothing in the log that says a refill was suppressed.
- **A `topUpCount` and a window, so N packs per period.** That is a different question — a budget rather
  than a rate — and it needs a period-scoped counter the close resets, which is a read-model change and
  a second meaning for "period".
- **Put the cooldown on the tier.** Right eventually, if tiers ever refill at genuinely different rates;
  it is not needed to close the runaway, and the threshold's move onto the tier is the precedent for how
  it would be done.
- **Refuse the crossing outright.** Simplest, and the customer's next genuine need waits for the next
  crossing, which may never come. The deferral is one extra event and answers the objection that kept
  this out of the first slice.

## What would reopen this

- A deployment that needs a different cooldown per tier: `Tier.topUp.cooldown` with the same guard and
  event rules as the threshold.
- A deployment that needs a budget rather than a rate: a period-scoped pack count, reset by the close.
- A declined charge that paykit should remember: a `TopUpFailed` event and the dunning policy, instead
  of a policy that dies and a platform that retries.
