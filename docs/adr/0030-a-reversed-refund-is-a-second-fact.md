# 0030 — A refund the provider reverses is a second fact

- **Status:** Accepted
- **Date:** 2026-11-08
- **Follows:** [0019](./0019-a-refund-names-the-charge-it-reverses.md), [0003](./0003-the-deploy-provisions-the-vendor.md)

## Context

[ADR 0019](./0019-a-refund-names-the-charge-it-reverses.md) recorded money going back and capped it
per currency: `refundableOf` is `charged - refunded`, never below zero. Both sides of that subtraction
are folds of events paykit wrote, and the ADR treats a `RefundRecorded` as final.

A provider can reverse a refund after acknowledging it: an ACH return, a refund to a card that has
since been closed, a chargeback the merchant loses. When that happens the money never left, and
paykit's log still says it did. Two things go wrong, and only one of them is visible:

- `refunded` stays high forever, so the ceiling understates what may go back. A second, legitimate
  refund of the same charge is refused `RefundExceedsCharged` — the account is denied money it is
  owed, and the reason is an event that describes a refund which did not happen.
- The account owes again. Nothing in the log says so, so a console shows a settled account that is
  not settled.

`RefundRecorded` is append-only and stays as it is. What is missing is the *next* fact.

## Decision

**1. `RefundReversed` is its own event, and `ReverseRefund` is the command.** The event names the
refund it undoes rather than the charge, because the refund is what happened and what has to be
found again:

- `refundId` — the provider's id for the refund being reversed, which is what `RefundRecorded`
  recorded;
- `amount` — the minor units that came back, which may be less than the refund;
- `currency`;
- `refundedAfter` — the currency's running total after the reversal, so a replay needs no sum, the
  same rule `RefundRecorded.refundedAfter` follows;
- `reason` — the provider's code, or an operator's note;
- `commandId` — the operator action or the provider delivery, so a redelivery is a replay.

**2. It is named `RefundReversed`, not `RefundFailed`.** [NEXT](../NEXT.md) queued the slice under
that working name; the event should not carry it. `RefundFailed` is already the tag the console's
refund RPC answers with when the *outcome of the attempt is unknown* (`Admin/Refund.ts`) — a caller's
answer, not a model fact. Two different meanings behind one word is how a support engineer reading a
log and a console at once gets the wrong story. `Reversed` also says what happened to the money,
which is what every other event name here does (`PaymentRecorded`, `CreditsExpired`).

**3. The reversal is capped by the refund it reverses, not by the currency.** `ReverseRefund` refuses
with `RefundReversalExceedsRefunded`, carrying which refund, how much it recorded, how much of it was
already reversed, and what was asked. The account-wide ceiling cannot be the cap here: two refunds of
one charge are two facts, and reversing the second must not be refused because the first is still
standing.

**4. `refunded` moves down and the headroom comes back.** `evolve` sets the currency's total to
`refundedAfter`, so `refundableOf` rises by exactly what returned. The credit pool is untouched —
ADR 0019's rule that a refund is money and not a move on the standing holds for its reversal.

**5. The record carries how much went back.** `RefundRecord` gains an optional `reversed` count. It is
optional so a record written before this ADR still decodes, which is the same shape
`dunningStartedAt` and `topUpCooldownUntil` use.

**6. It carries the `Admin` guard, and it is on the operator Api.** Unlike `Refund`, whose provider
call is why the binding lives in the process that holds the provider, a reversal needs no provider:
the money already moved. So `ReverseRefund` joins `BillingAdminApi.commands`, and any operator
process can send it.

Shipping the command required the screen, not the other way round: `paykit-admin`'s "covers every
admin Api command" test refuses an Api command with no console action behind it, and a busywork
action would satisfy the letter of that gate while breaking its point. So the console landed with
it: `BillingState` carries the refunds themselves (`refunds`, keyed by the provider's id), the
refunds panel renders one row per refund with `amount`, `reversed` and `outstanding`, and a row
offers **Reverse** only while `amount - reversed` is positive. That button opens the same generated
draft every other action uses, pre-filled with the refund and its outstanding amount, so an operator
never copies an id to reverse a refund they can see.

## Consequences

- A currency's refundable headroom is the truth again after a reversal, so a refund that is owed can
  be paid.
- The console reads the refunds themselves, not only the per-currency total. `refunded` answers "how
  much went back"; `refunds` answers "which refund can still come back", and only the second can
  offer a button that names one.
- The console can show a refund as reversed rather than settled. `BillingState` already folds the
  money; the fold now has a fact to subtract.
- Two events describe one refund: what went back, and what came back. A reader that wants the net
  amount reads both, which is the cost of an append-only log and the reason `refundedAfter` is on
  both.
- The timeline gains a `refund-reversed` kind so the money moving back is a visible entry rather than
  a counter that silently shrinks.
- The provider's reversal has to reach paykit through a webhook decoder or an operator. This ADR does
  not add a decoder: `Payments` has no reversal stream, and inventing one from a chargeback payload
  before a vendor needs it would be a port shaped by a guess.

## Alternatives considered

- **Delete the `RefundRecorded`.** It cannot be done: the log is append-only, and the refund did
  happen — the provider acknowledged it.
- **Write a negative `RefundRecorded`.** It would re-use a `refundedAfter` that a reader would have to
  interpret as a direction, and it puts "refund" and "un-refund" in one tag. The money moving back is
  a different fact, not a signed amount.
- **Cap by the currency and skip the per-refund ceiling.** Simpler, and it lets one refund be reversed
  twice, which is how a log ends up describing a negative refund.
- **Treat a reversal as a chargeback and open a dispute.** A dispute is a vendor process with states
  paykit does not model. The fact paykit needs is that the money is back.

## What would reopen this

- A vendor that reverses a refund by a different id than the refund it acknowledged: the event would
  need the charge too, and `refundId` would become a lookup rather than the subject.
- A refund that should revoke the credits it paid for in the same call: that is a change to ADR 0019's
  "a refund never touches the pool", not a field on this event.
