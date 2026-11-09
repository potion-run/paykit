# 0042 — A quantity credit settles the next charge

- **Status:** Accepted
- **Date:** 2026-11-11
- **Follows:** [0023](./0023-a-seat-is-a-quantity-that-is-set.md), [0019](./0019-a-refund-names-the-charge-it-reverses.md), [0036](./0036-a-seat-is-purchased-and-occupied.md), [0040](./0040-an-entity-is-a-scope-not-a-customer.md)

## Context

`SetQuantity` records a proration for the rest of the period. Adding a seat is a positive `due`;
removing one is a negative `due`, because the account paid for time it will not use. ADR 0023 §4
said the credit "is recorded on the standing for audit", and nothing consumed it. The comment on
`quantityProrations` promised "the next period will apply it", but no close and no charge path read
the entry. A customer was promised a credit the implementation never spent — [FINDINGS
F9](../../specs/paykit/FINDINGS.md).

The money already exists: the reduction lowered `due`, and the entry is keyed by the caller's
`dedupeKey`. What is missing is the transition that spends it.

## Decision

**1. A negative `due` on a `quantityProrations` entry is a credit.** It is money the account is
owed for the rest of the period, in the entry's currency. It is never a refund and never paid out as
cash: paying money out is `Refund`, which is a provider action with a charge to reverse (ADR 0019),
and there is no charge here.

**2. The next quantity charge spends it.** `ApplyQuantityCredit` names an uninvoiced, positive
quantity change and spends the account's credits against it, oldest first. The amount is the smaller
of the credit remaining and the charge's `due`, so the charge is reduced but never goes below zero.
A credit larger than the charge leaves a remainder on its own entry for a later charge; the
remainder is not cash and is not written off.

**3. The application is a fact in the log.** `QuantityCreditApplied` records the target change, the
credits consumed with their amounts, the total, the currency, and the charge before and after. The
target's `Proration` becomes `charge - credit`; the source entries record `creditApplied`. A fold
reproduces the net due without replaying every past change, and a console can say which reduction
paid for which increase.

**4. `ChargeQuantityProration` spends before it bills.** The collector applies the credits, then
opens the provider invoice for the net. If the credit covers the charge fully, it records the
application and opens no invoice: "nothing to charge" is the outcome, not a zero invoice. If the
provider refuses, the credit is still spent against the charge; a retry bills the remainder, so the
customer is not charged for money the credit already covered.

**5. A replay applies once.** `ApplyQuantityCredit` is keyed by the target change and the source's
`creditApplied` is monotonic. A replay of `SetQuantity` records no new change (the quantity did not
move), and a replay of the application finds the target's due already reduced and records nothing.
Two charges cannot spend the same credit twice.

**6. A period close neither spends nor drops the credit.** A close has no quantity charge to
settle; it resets allowances and keeps the quantity. The credit is money, not a period counter, so
it survives the boundary and the first change of the next period spends it. `UsageReset` never
touches `quantityProrations`, and the close's events do not either.

**7. A vendor that opens its own invoice is the authority for that invoice.** A provider with the
`quantity` capability computes its own proration (Stripe's `always_invoice`, Polar's
`next_period`), so the standing records the amount the vendor opened. Those credits stay on the
standing for a later paykit-collected change. A provider without the capability keeps the local
path, where `ChargeQuantityProration` spends them. This is the same split ADR 0023 §3 already draws
between the vendor's item and the local collector.

## Slices

### 1 — the state and the event

Landed. `QuantityProration` gains `creditApplied` and `recordedAt` (credits are consumed oldest
first); `QuantityCreditApplied` and `ApplyQuantityCredit` are part of the aggregate; the
`QuantityChanged` fold records the envelope's `at`. The helpers `unappliedQuantityCreditOf`,
`quantityCreditsOf` and `quantityCreditUsesOf` are pure so the collector and `decide` compute the
same allocation.

### 2 — the collector

Landed. `ChargeQuantityProration` applies the credits before opening the invoice, bills the net, and
reports `creditApplied` in its result. A fully covered charge returns `{ outcome: "nothing",
creditApplied }` and opens no invoice.

## Consequences

- **The credit is money that moves once.** A reduction reduces what the next increase costs, the
  log names the source and the target, and `charged` folds the net invoice. A refund ceiling that
  trusts `charged` no longer sees a credit as a charge (F2).
- **Seats are still a quantity, not a wallet.** A credit has no balance feature, no reset and no
  expiry of its own; it lives on the change that recorded it and is spent by the next charge in its
  currency. It survives a tier change, a close and a terminal standing's remaining state; it does
  not survive a replacement, which starts a new standing.
- **A fully covered charge has no invoice.** `RecordQuantityProrationInvoice` still refuses a
  non-positive due, so nothing can bill zero or bill the credit itself.
- **A credit is not a refund.** `Refund` still caps itself by `charged`, and a credit was never
  charged. Paying a credit out in cash remains a deployment decision about a refund it chooses to
  make, not a subscription rule.

## Alternatives considered

- **Apply the credit at `SetQuantity` and record the net there.** Rejected: a vendor that opens its
  own invoice would then be told a net amount while its invoice is gross, so the log would stop
  matching the money the provider collected. The application belongs to the collector that opens
  the invoice.
- **A credit wallet with its own balance and expiry.** Rejected: `quantityProrations` already
  records the money and its key, and a wallet would need a second place for the same amount to
  disagree. The credit is a fact about a change, not a new balance source.
- **Pay the credit out as a refund automatically.** Rejected: a refund is money leaving the
  account against a charge, and a reduction's credit is money never charged. It settles the next
  charge; it does not leave as cash.
- **Apply the credit at the period close.** Rejected: a close has no quantity charge to settle. A
  close that consumed the credit would either write it off or invent an invoice for the next
  period's plan, which the vendor subscription owns.

## What would reopen this

**A provider that applies an account credit to its own invoice.** If the payments port gains a
credit or discount operation, `SetQuantity` could hand the vendor the credit and this ADR's split
between local and vendor invoices would collapse. **A credit in one currency settling a charge in
another** would need an exchange rate and a rule for who bears it; the current rule is that a
currency only spends its own credits. **An expiry for credits** would make them a balance source
with a deadline, which is ADR 0037's shape rather than this one.
