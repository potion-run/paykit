# 0019 — A refund names the charge it reverses, and the money paykit recorded caps it

- **Status:** Accepted
- **Date:** 2026-11-06
- **Follows:** [0003](./0003-the-deploy-provisions-the-vendor.md), [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md), [0018](./0018-a-saved-method-is-a-capability.md)

## Context

[NEXT](../NEXT.md) ends its console list with the one screen paykit cannot serve: refund. It could not,
because there is no refund command — no event says money went back, and the only trace of a refund is
whatever the vendor dashboard shows. Three questions have to be answered before code: which event,
which money, which provider call.

What the model already knows about money is one-directional. Money *in* is recorded: `PaymentRecorded`
(a payment that recovered a standing), `CreditsPurchased.price` with its `invoiceId` or `chargeId`
(a pack), `ProrationInvoiced` (an upgrade's difference). Money *out* is recorded nowhere. ADR
[0003](./0003-the-deploy-provisions-the-vendor.md) is explicit that nothing a bill references is
deleted, so a refund cannot be a reversal — it is another fact.

## Decision

**1. A refund is an operator act and a fact.** `Refund` records `RefundRecorded`; it carries the
`Admin` middleware like every command that moves money, and there is no tenant-facing refund verb. A
customer asks; an operator decides. The alternative — a customer command — would make every refund a
policy question (how many, how much, how late), and the library has no business answering it.

**2. The event carries the money, the evidence and the running total.** `RefundRecorded` holds
`chargeId` (what the operator refunded, as the provider names it), `refundId` (what the provider
returned), `amount`, `currency`, an optional `reason`, `refundedAfter` — the currency's running total
after this refund — and the `commandId` of the operator action that recorded it. The last two are the
same shape as `balanceAfter`: a replay reproduces the refunded total from the log alone, and a retried
refund is found by the key it was recorded under rather than spent against the ceiling twice.

**3. The ceiling is what paykit recorded as charged, per currency.** The standing folds two maps:

```
charged  += PaymentRecorded.amount, CreditsPurchased.price.amount, ProrationInvoiced.amount
refunded += RefundRecorded.amount
```

and `decide` refuses `RefundExceedsCharged` when `refunded + amount > charged` for the currency. It is
a ceiling, not a standing: spending into it changes nothing else about the account.

The ceiling is deliberately **not per charge**. `chargeId` is evidence, not a foreign key: a checkout
purchase arrives through a webhook whose payload (`WebhookEvent`) carries no vendor order id, so
paykit records the pack's price and no reference at all. A per-charge ceiling would refuse the
commonest refund — one for something a customer bought at checkout — while the account-level ceiling
answers the question an operator actually has ("how much of this account's money has gone back?").

**4. A refund never touches the credit pool.** Revoking the credits a refund leaves spendable is
`ConsumeCredits`, which an operator session may already send for any account. Keeping them as two
commands keeps the log honest: "money left" and "credits were burned" are separate facts with separate
amounts, and neither has to guess the other's. A refund that quietly debited the pool would be a second
ledger, repricing a purchase at today's rate card.

**5. The provider call belongs to the binding, and the port answers a refund id.** `decide` is pure,
so only an effect can ask a provider for money: the `Refund` binding asks the account's provider for
`refund({ chargeId, amount, commandId })`, then sends the command with the returned `refundId`. The
`commandId` is the operator's `dedupeKey`, so a retry is the same refund at the provider and the same
command here. `Payments.refund` therefore stops answering `{}` and starts answering `{ refundId }`,
which is what the event needs to be auditable against a vendor dashboard.

The binding checks two things before it takes money: whether this `dedupeKey` already recorded a
refund (in which case it answers that one — a retry must not be measured against a ceiling the first
attempt spent), and whether the amount fits the ceiling below. `decide` repeats both checks, because
the provider call cannot be undone.

**6. The clearance follows the call.** `Refund` is implemented in `BillingAdminInProcess`, where the
provider is reachable, and not in `BillingAdminApiLayer` — a console backend that owns only the Api
cannot take money out, exactly as it cannot collect a proration. That is the layer being the clearance
([`BillingAdminInProcess`](../../packages/paykit/src/Billing/BillingAdminInProcess.layer.ts)), not a
missing verb.

**7. The page says what can still go back.** `BillingState` carries `charged` and `refunded` per
currency, so a console renders "charged 4,900, refunded 0" beside the account instead of asking an
operator to remember, and the timeline gets a `refund` entry so the money is visible in the account's
story.

## Consequences

- **A refund is capped by what paykit recorded.** A payment the deployment never recorded — a transfer
  reconciled only in the vendor's dashboard — cannot be refunded through paykit until it is recorded.
  That is the ledger working: `RecordPayment` is the way to add money in, and a refund cannot exceed
  what the log knows.
- **A refund and a credit revocation are two operator calls.** A console offers both; a deployment that
  only wants the money back sends one.
- **The vendor remains the authority on the refund's state.** A refund that the provider later fails is
  a `refund.failed` webhook paykit does not model yet, and the event records "a refund was taken", not
  "the money arrived". A `RefundFailed` event is the next decision if a deployment needs it.
- **`Charged`/`refunded` are folds, so an old log folds to `{}`.** No event is rewritten and no state
  version is bumped: the maps are optional keys that decode with absence and total from the events that
  carry money.

## Alternatives considered

- **Reuse `PaymentRecorded` with a negative amount.** A payment and a refund answer different questions
  ("money arrived" vs "money went back"), and a console, the timeline and the dunning policy would all
  have to branch on sign. One event per fact, as with `CreditsPurchased`.
- **A per-charge ceiling keyed by `invoiceId`/`chargeId`.** Precise where a reference exists, and
  useless where it does not — the checkout path, which records a price and no reference.
- **Refund everything: money and the credits it bought.** The pool is not priced per charge (one pool
  per account, ADR [0002](./0002-credits-are-the-unit-of-account.md)), so "the credits that refund
  bought" is not a number the model holds. Revoking a chosen number is `ConsumeCredits`.
- **Let the tenant Api refund.** Every refund would become a policy the library has to own, and a
  customer could drain a pool's paid value without an operator seeing it.
- **A refund without a ceiling.** Simplest, and it makes the ledger a log of intentions: an operator
  typo would record money leaving that never did.

## What would reopen this

- A provider that reports a failed refund: a `RefundFailed` event, and the timeline and the page
  branching on it.
- A refund that must revoke credits in one call: a `credits` field on the command, with the pool's
  `prepaidCredits` accounting and a `RefundExceedsCredits` refusal.
- A per-charge ceiling, once something records the vendor's reference on the checkout path.
