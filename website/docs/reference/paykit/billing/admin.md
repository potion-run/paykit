---
title: "Admin"
description: "Exports `GrantCredits`, `ExtendTrial`, `EnterGrace`, `Recover`, `Expire`, `RecordPayment`, `RecordPaymentFailure`, `Refund`."
---

> **Source:** [`packages/paykit/src/Billing/Admin.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Admin.binding.ts#L251)

## GrantCredits

> **Kind:** Binding · **Product:** Credits · **Provides:** `Paykit.GrantCredits`

Grant credits to the pool. An operator's correction, not a purchase: a bought
pack is `PurchaseCredits` with an invoice, so the log can tell a gift from a
sale.

### Granting credit

```typescript
const grant = yield* Paykit.GrantCredits(account);
const { balance } = yield* grant({ amount: 250, dedupeKey: ticketId });
```

## ExtendTrial

> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.ExtendTrial`

Move a trial's deadline forward. It only moves forward: a deadline that is not
after the one in force is `TrialDeadlineNotLater`, so a lagging operator cannot
shorten a trial by accident.

### Extending a trial

```typescript
const extend = yield* Paykit.ExtendTrial(account);
yield* extend({ trialEndsAt: DateTime.add(now, { days: 7 }), dedupeKey: ticketId });
```

## EnterGrace

> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.EnterGrace`

Put a standing into grace until a deadline. Grace keeps the account working
while a payment is retried, and `GraceElapsed` at the deadline is what ends it.

### Opening grace by hand

```typescript
const enterGrace = yield* Paykit.EnterGrace(account);
yield* enterGrace({ graceUntil: DateTime.add(now, { days: 7 }), dedupeKey: ticketId });
```

## Recover

> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.Recover`

End grace because the payment arrived. A recover outside grace has nothing to
end, so the model answers `NotInGrace`.

### Recovering an account

```typescript
const recover = yield* Paykit.Recover(account);
yield* recover({ dedupeKey: paymentId });
```

## Expire

> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.Expire`

End the standing now, after grace has run out. Nothing in a delete path
cancels, refunds or deletes provider state (ADR 0003), so this records an
expiry and leaves the vendor's records alone.

### Expiring an account

```typescript
const expire = yield* Paykit.Expire(account);
yield* expire({ dedupeKey: graceEventId });
```

## RecordPayment

> **Kind:** Binding · **Product:** Payments · **Provides:** `Paykit.RecordPayment`

Book money that arrived outside the provider's webhook: a bank transfer on a
manual invoice, a payment an operator reconciled by hand.

### Recording a transfer

```typescript
const recordPayment = yield* Paykit.RecordPayment(account);
yield* recordPayment({ amount: 1900, currency: "usd", dedupeKey: invoiceId });
```

## RecordPaymentFailure

> **Kind:** Binding · **Product:** Payments · **Provides:** `Paykit.RecordPaymentFailure`

Record a failed payment and the grace deadline it opens. The attempt count
is what a console shows and the deadline is what the sweep acts on; a
deployment that installs the `dunning` layer also retries the saved method
on its ladder before that deadline.

### Recording a declined card

```typescript
const failed = yield* Paykit.RecordPaymentFailure(account);
yield* failed({ reason: "card_declined", graceUntil: DateTime.add(now, { days: 7 }), dedupeKey: eventId });
```

## Refund

> **Kind:** Binding · **Product:** Payments · **Provides:** `Paykit.Refund`

Send money back for a charge the account already paid.

Three rules, from [ADR 0019](https://github.com/potion-run/paykit/blob/main/docs/adr/0019-a-refund-names-the-charge-it-reverses.md):

- **The ceiling is what the log records.** A refund cannot exceed what the
  account was charged in its currency, minus what already went back
  (`RefundExceedsCharged`). The binding checks it before it calls the
  provider, so a refund the model would refuse never leaves the account.
- **The provider takes the money, the log records it.** `Payments.refund` is
  keyed by `dedupeKey`, so a retry is the same refund at the vendor and the
  same command here; the provider's refund id is what the event carries.
- **A refund does not touch the pool unless it says so.** Revoking credits is
  `ConsumeCredits`, sent separately, so "money left" and "credits were burned"
  stay two facts. `revokeCredits` records both in one call and still as two
  events, and both ceilings are checked before the provider is asked
  (ADR 0032).

It is implemented where the provider is reachable — the in-process operator
layer — because a console backend that owns only the Api cannot move money.

### Refunding a pack

```typescript
const refund = yield* Paykit.Refund(account);
const { refundId, refunded } = yield* refund({
  chargeId: "ch_123",
  amount: 1900,
  currency: "usd",
  reason: "duplicate order",
  dedupeKey: ticketId,
});
```
