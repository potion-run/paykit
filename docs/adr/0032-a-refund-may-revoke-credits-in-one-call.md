# 0032 — A refund may revoke credits in the same call, but they stay two facts

- **Status:** Accepted
- **Date:** 2026-11-08
- **Follows:** [0002](./0002-credits-are-the-unit-of-account.md), [0019](./0019-a-refund-names-the-charge-it-reverses.md), [0030](./0030-a-reversed-refund-is-a-second-fact.md)

## Context

[ADR 0019](./0019-a-refund-names-the-charge-it-reverses.md) ends with a rule: **a refund never touches
the credit pool.** Its reason was that "money left" and "credits were burned" are two facts, and an
operator who sends money back should have to say so separately.

The rule is right about the facts and wrong about the call. The case it was written for — a customer
who paid for a pack, got the credits, then asked for the money back — needs both: the money returns
*and* the credits it bought stop being spendable. Today that is two operator actions, and an operator
who takes the first and forgets the second has given the account the pack for free. The log cannot
tell a deliberate gift from a forgotten step.

Two facts can still be two events in one command. What ADR 0019 refused was a refund that *implies* a
revocation; what this adds is a refund that *states* one.

## Decision

**1. `Refund` gains an optional `revokeCredits` amount.** Absent, nothing changes: the command records
`RefundRecorded` and the pool is untouched, exactly as ADR 0019 says. Present, one command records
`RefundRecorded` **and** `CreditsConsumed`, in that order. The log is the same two facts it would hold
after two calls; the operator made one.

**2. Both ceilings are checked before either fact is recorded.** `RefundExceedsCharged` already guards
the money. The revocation is capped the way `ConsumeCredits` caps it — `credits - reserved`, because a
hold's credits still have to settle — and refuses with the same `CreditExceedsBalance`, so "the pool
cannot cover this" reads the same whether an operator burned credits alone or with a refund. A refund
is refused as a whole: no money goes back, no credits burn.

**3. The binding checks the credit ceiling before it calls the provider.** The provider call happens
before the command, so a ceiling only `decide` knows would send money out and then refuse to record
it. `BillingAdminInProcess`'s refund verb already checks the money ceiling for that reason; it now
checks this one too.

**4. Two events, not one.** `RefundRecorded` states the money and `CreditsConsumed` states the pool,
each with the numbers it already carries. A single event with both would make every reader that folds
`refunded` also decide what to do about credits, and would put a `balanceAfter` on an event about
EUR.

**5. A revocation rides a refund.** `Refund` records nothing for a non-positive `amount`, and that
stays: with nothing to refund, burning credits is `ConsumeCredits`, which an operator session already
sends. The console's form requires a positive amount, so the combination is a caller's mistake rather
than a path.

**6. The console offers it as a field, not an action.** The refund form asks for credits to revoke
beside the amount, because they are one decision about one charge. A separate button would recreate
the forgetting this ADR exists to prevent.

## Consequences

- An operator who refunds a pack and means to take its credits back can now say so once. The console's
  form makes the two halves one submission, and the log still shows each half separately.
- The refund is atomic in the model and not across the provider: the money is sent before the command,
  so both ceilings are checked at the edge. A provider that fails between the two leaves the same
  window ADR 0019 already has, and the command id makes the retry a replay.
- `RefundRecorded` and `CreditsConsumed` share one command id. A reader that counts commands rather
  than events sees one operator action, which is the truth.
- A reversal of a refund does **not** restore revoked credits. ADR 0030's reversal moves money; the
  credits were burned by a decision, and restoring them is `GrantCredits`.

## Alternatives considered

- **Make the refund always revoke.** It would take credits from accounts that keep them deliberately —
  a partial refund for a service credit, a goodwill refund on a plan whose grants are still owed — and
  it would silently change what every existing `Refund` call means.
- **Two commands sent by one endpoint.** Atomicity would be the endpoint's, and a crash between them
  would leave money back with credits still spendable. One `decide` is the only place an all-or-nothing
  pair can be decided.
- **One event with both.** It reopens ADR 0019's separation, and every fold that reads `refunded` would
  have to grow a rule about a pool it never asked about.
- **Let the revocation go negative.** A negative pool is a state no read explains, which is why
  `ConsumeCredits` refuses it.

## What would reopen this

- A refund that revokes a *rate card's worth* of credits rather than a count: that is a pricing
  question, and `creditRatesOf` would have to answer it per feature.
- A provider that can reverse the money when a revocation is refused: nothing here would change; the
  binding's checks would simply have a way to be undone.
