# 0025 — A dunning ladder is a scheduled retry

- **Status:** Accepted
- **Date:** 2026-11-07
- **Follows:** [0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md), [0018](./0018-a-saved-method-is-a-capability.md)

## Context

The first dunning slice owned the clock and not the collection. A `PaymentFailed` entered grace,
`Dunning` scheduled `GraceElapsed` at the deadline, and grace expired the standing when it arrived.
The retries were the provider's because `Payments` had no operation for asking a card to be charged
again; [ADR 0018](./0018-a-saved-method-is-a-capability.md) added `charge` for the auto top-up and
named dunning as the next thing it would reopen.

The result is one window with one attempt in paykit's log. A card that was temporarily declined is
never asked again by the deployment that knows the account; it recovers only if the vendor happens
to retry, and the attempt count moves only when a webhook happens to arrive. A deployment that runs
its own collection schedule has no way to say so: the retry is outside the event log, so a console
cannot tell a retry that failed from one that never happened.

The deadline machinery already exists and is not new. `HoldSweep` schedules `HoldElapsed` from the
hold's `expiresAt`, and `TopUpCooldownElapsed` clears a cooldown at the deadline it records. A retry
rung is another command of that shape: it decides from the standing, not from a policy's clock.

## Decision

**1. Retries are opt-in, and the ladder is deployment data.** `Paykit.dunning({ retries })` takes
an array of `effect/Duration` and returns the layer the policy reads. Each entry is measured from
the first failure of the run: `[1 day, 3 days, 7 days]` means three retries at those ages, not a
delay of three days after the retry at one day. Without the layer nothing changes: `Dunning` still
owns grace and expiry and makes no charge. The default is unchanged because charging a saved method
on a schedule is the deployment's decision, and because a vendor that already runs dunning must be
able to keep that job.

**2. The run has an identity on the standing.** The first `PaymentFailed` of a run records
`dunningStartedAt`; later failures in the same run keep it. The field is optional so an event
written before the ladder existed still decodes. A payment or a recovery clears it, and a terminal
standing is replaced by a new activation rather than carrying the old run forward. The field is on
`PaymentFailed` and on the standing, not only in policy memory: a replay must reproduce which run a
scheduled rung belongs to.

**3. A rung is a command, not a timer.** After a failure the policy schedules `DunningRetry` for
every rung that is still before `graceUntil`. The command records `DunningRetryDue` only while all
of these hold:

- the standing is still in grace;
- the command's clock is before the grace deadline;
- `dunningAttempts` still equals the attempt the rung followed;
- the ladder's `startedAt` still matches the standing.

Anything else is a no-op. A recovery, a newer failure or a passed deadline therefore cannot make a
stale rung charge a card. The rung carries the attempt it becomes and the price the standing holds
when it fires, so a replay reproduces what was asked for without reading a catalog.

**4. The policy takes the money and the log records it.** On `DunningRetryDue`, `Dunning` charges
the account's saved method through `Payments.charge`, using the run and the attempt as the
idempotency key. A successful charge sends `RecordPayment`, which clears grace and the attempt
count. A `PaymentDeclined` sends `RecordPaymentFailure` with the same grace deadline, so the failure
is the next attempt and the ladder continues from it. A provider without `charge` dies with
`ProviderCapabilityMissing`, never a silent no-op: a deployment that asked for retries on a provider
that cannot make one has a configuration error, and the tag is the evidence.

**5. `GraceElapsed` is still the one hard stop.** A rung at or after `graceUntil` is not scheduled;
after the last rung the standing waits for the deadline and expires. Expiry never waits for a retry
to finish, and a retry never extends the window. That is the same division the first slice had,
with the missing attempts inserted before the deadline.

**6. `dunningAttempts` counts failures, not rungs.** A rung that succeeds clears it; a rung that is
declined records a `PaymentFailed` and increments it. The field keeps its meaning for a console and
a webhook that never heard of the ladder.

## Consequences

- **A deployment without the layer is unchanged.** The policy schedules the deadline only, makes
  no provider call, and writes exactly the event stream it wrote before.
- **A deployment with the layer should disable the vendor's dunning.** Two schedules charging one
  saved method is two attempts to reconcile, even with an idempotency key per run and attempt.
- **Only a provider that declares `charge` can run a ladder.** Stripe's optional off-session
  `PaymentIntent` path qualifies; Polar, a merchant of record, already collects through its order,
  and `Manual` has no card.
- **The log grows one `DunningRetryDue` per rung.** It is the replayable record of what was tried,
  the same cost `HoldElapsed` and `PeriodEnded` already pay.
- **The ladder is per deployment, not per tier.** A tier-specific cadence would be a later field on
  `Tier`, with the same rule that `decide` never reads the catalog. The deployment-level ladder is
  the small decision that closes the gap.

## Alternatives considered

- **Leave retries to the provider.** The old position, now that the port has `charge`. It keeps the
  retry outside the log, makes the attempt count depend on a webhook arriving, and gives a
  deployment that owns its collection no way to say when it retried.
- **A policy that sleeps and charges in a loop.** A policy that sleeps holds a stream, and there is
  still nothing in the log that says a rung was due or why it did not run.
- **Schedule the whole ladder once and never replan it.** Simpler, but a later failure with an
  extended grace deadline would leave the old rungs behind. Replanning from the current attempt
  keeps the same ids for the future rungs and lets one that was lost be written again.
- **Fall back to an invoice when `charge` is missing or declined.** A retry is not a new invoice.
  A decline is recorded as a failure so the next rung is the next attempt; a missing capability is
  a deployment error, not a second way to collect.
- **A default ladder.** It would change every existing deployment's money behaviour and collide
  with vendor dunning. The layer is how a deployment says it wants paykit to own the attempts.

## What would reopen this

- A per-tier cadence: a `Tier` field and the same event and command rules.
- A provider that can retry an invoice rather than a saved method: a new port operation, not a
  reinterpretation of `charge`.
- Vendor dunning that exposes its own attempt schedule: a decoder that reports the attempt on
  `PaymentFailed`, so a deployment can run one schedule and record the other.
