# 0027 — A top-up that could not be bought is a fact in the log

- **Status:** Accepted
- **Date:** 2026-11-07
- **Follows:** [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md), [0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md), [0018](./0018-a-saved-method-is-a-capability.md), [0026](./0026-a-tier-states-its-whole-top-up-line.md)

## Context

An auto top-up calls a provider, and a provider call can fail. [ADR
0018](./0018-a-saved-method-is-a-capability.md) already decides what happens to a **declined
charge**: the policy falls back to an invoice, and only a deployment with neither capability stops.
What is left is the case where the fallback fails too — the card is declined and the invoice cannot
be opened, the provider is down, the request times out — and the policy's answer to all three today
is `Effect.orDie`.

That is the worst shape this failure can take:

- **The account sees nothing.** The crossing was real: the pool is below the line, the deployment
  said to refill it, and it was not refilled. The standing reads as if no crossing happened.
- **An operator sees nothing in paykit.** A die reaches the platform's logs, which are a different
  store with a different retention and no account on the row. "Why did this account run dry" is a
  question about the account, and the answer has to be beside the account.
- **A retry has nothing to dedupe against.** A redelivered spend runs the policy again and asks the
  provider again, with no record saying the first attempt already failed.

[ADR 0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md)'s "What would reopen this" names
this exact slice — "a refusal from the vendor that paykit has to remember (a declined card): a
`TopUpFailed` event and the dunning policy" — and [ADR
0018](./0018-a-saved-method-is-a-capability.md) repeated it for a decline that must be remembered.
This takes the event and leaves the dunning half to its own decision.

## Decision

**1. `TopUpFailed` is its own event, not a `PaymentFailed`.** The two look alike and are not:

```ts
new TopUpFailed({
  tier,        // the pack the line named
  price,       // what would have been charged
  provider,    // the provider that refused, or the one with no capability
  reason,      // the refusals's tag, for an operator to match
  at,          // when the crossing gave up
  commandId,   // the crossing, so an operator can tie it to the spend
})
```

A `PaymentFailed` moves a standing into `grace` — it is the record that an account owes money and is
being dunned. A failed top-up means the opposite: nothing was charged, nothing is owed, the standing
is exactly where it was. Recording it as a `PaymentFailed` would grace an account for a payment it
never made, and [ADR 0020](./0020-a-terminal-standing-is-replaced-not-moved.md) already made the
standing's terminal edges refusals rather than silent moves.

**2. The policy records the failure instead of dying.** A declined card is business, not a bug: the
crossing did everything the deployment asked and the provider said no. Dying would put the cause in
the platform's logs, which is the store this slice exists to stop depending on, and would make a
redelivery a retry of a decision already recorded. The account is where the answer belongs, so the
failure becomes state. The one exception is unchanged: an account with **no** provider capability at
all still dies with `ProviderCapabilityMissing`, below.

**3. The standing carries the last failure.** `SubscribedState.topUpFailure` holds the pack, the
provider, the reason and the time, so a page can say "the refill that should have bought the 100k
pack on 12 May was declined by Stripe" without reading the event stream. The next `CreditsPurchased`
clears it: the field answers "is this account currently short of a refill it was promised", and a
successful purchase is what makes that false. A tier change does not clear it — the failure happened,
and a plan's change of line does not make it not have happened.

**4. The cooldown is what retries.** [ADR
0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md) writes the deadline *before* the
purchase, so a crossing that fails still leaves a deadline scheduled. When it fires, `decide` clears
the cooldown and the policy asks the pool the same question again — is it still at or below the line?
— and buys then. That gives one retry per cooldown window instead of one retry per redelivery, and it
needs no clock and no new command. A deployment with no cooldown at all has no deadline to retry on,
which is the same deployment that already opted into buying on every crossing.

**5. A missing capability still dies without a record.** An account whose provider is not in the
router is a deployment that cannot bill that account at all; the boot-time check already refuses a
deployment with no router, and this case means the *account* has no provider, which is
misconfiguration rather than a failed purchase. There is no pack to name and no amount that was
going to be collected, and `ProviderCapabilityMissing` stays the tag a deployment matches — the
standing is not where that fact belongs.

## What this does not decide

- **Dunning a failed top-up.** Nothing is owed after a failure, so there is nothing to dun. A
  deployment that wants to escalate after N consecutive failures needs a count on the standing and a
  policy, not an event.
- **A charge that succeeded but whose credits never recorded.** That is the crash between a side
  effect and its record — the case the outbox and the crossing-keyed `PurchaseCredits` already
  handle, and the case [`spec/PaykitAutoTopUp.tla`](../../spec/PaykitAutoTopUp.tla) models. A
  `TopUpFailed` is written only when the provider call itself failed.
- **Un-reviewable money.** A failed refund keeps the same shape and gets the same treatment when it
  lands, which [the refund brief](../briefs/refund.md) already names as `RefundFailed`.

## Consequences

- **The event is additive** to the log and to the standing, and the package is `0.1.0`, unpublished
  and never deployed, so no older record has to decode without it.
- **`BillingState` gains a field**, so a console renders the failure beside the balances and the
  cooldown it already shows.
- **The policy's failure path is a transaction, not a die.** A redelivered spend resolves to the
  same failure record by the crossing's id, so a retry does not write a second one.

## Alternatives considered

- **Fold it into `PaymentFailed`.** Grace an account for a payment nobody asked it to make, and give
  the dunning policy a state it should never act on.
- **Record it in the read model instead of the log.** The `BillingRead` projection would then be the
  only place the fact exists, and a rebuild from events would lose it — the projection is derived,
  the log is the record.
- **Retry inside the policy with a backoff.** A policy that schedules its own retries duplicates the
  deadline machinery [ADR 0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md) already
  built, and a backoff that lives in an effect is not replayable.
- **Let the die be the record.** The platform's logs are a different store with no account on the
  row, which is the problem this slice exists to fix.

## What would reopen this

- A retry budget per period rather than per cooldown window: a count on the standing and its own
  refusal.
- A failure the deployment must page someone for: a threshold on consecutive failures, which needs
  the count above.
- A refund or a charge reversal that fails: `RefundFailed`, with the same shape and the same rule.
