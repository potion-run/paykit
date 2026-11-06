# 0023 — A seat is a quantity that is set, not a counter that is spent

- **Status:** Accepted
- **Date:** 2026-11-06
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0005](./0005-a-spend-cap-is-a-ceiling-in-units.md), [0022](./0022-the-catalog-states-the-price-the-schedule-and-the-rate-card.md)

## Context

`seats` is already a declared feature in `Feature.ts`, and `resets: "never"` is
already a legitimate allowance. Neither makes it a seat. A `resets: "never"`
allowance is still a counter: `TrackUsage` increments it, a hold reserves
against it, and a period close leaves it alone. A seat is the opposite shape:

- It is **set**, not incremented. The app knows how many people are on the
  account; it says so, and a retry of the same call is the same quantity.
- It is **prorated** when it changes. Adding a seat mid-period is worth the
  unused fraction of that seat's price; removing one is a credit.
- It has a **free grant** and a **cap**, not a spendable `remaining`.
- It is **never spent**. A seat is occupied, not consumed, so `Track` and `Hold`
  are the wrong verbs.

The catalog could not express any of that, and the model had no command that set
a quantity.

## Decision

**1. A non-consumable feature is a third kind.** `Feature.kind` and
`Allowance.kind` gain `"non_consumable"`. Its allowance states a numeric
`included` (the free quantity), `resets: "never"`, an optional `cap` (the most
the quantity may reach, including the free grant), and an optional one-rate
`pricing` for each additional unit per period. It cannot carry, reset, or state a
`moneyCap`; a ladder is refused because a seat has one price. `overage` is
`"block"` (no additional seats), `"allow"` (additional seats are free) or
`"bill"` (additional seats are priced, and then `pricing` is required).

**2. `SetQuantity` sets the total, not a delta.** The command carries the
quantity the account should hold, including the free grant. The billable
difference is `max(0, new − included) − max(0, old − included)`; only that
difference is prorated, by the unused fraction of the standing's period.
`prorate: "immediate"` (the default) records the proration; `"period_end"`
records the quantity and lets the next period bill it in full. A quantity below
the free grant is allowed: giving back free seats is not a refund.

**3. The event carries the money and the key.** `QuantityChanged` records the
quantity before and after, the `Proration` and the `prorationId`, which is the
command's required `dedupeKey`. The standing keeps `quantities` and
`quantityProrations`; the latter is the unbilled money a change moved.

**4. `ChargeQuantityProration` collects a positive `due`.** Like a tier change's
proration, a positive difference is opened as a provider invoice keyed by the
change, and `QuantityProrationInvoiced` records it. A reduction's credit stays on
the standing for the next period; paying it out is a refund, which is a provider
action, not a subscription one.

**5. `TrackUsage` and `Hold` refuse a quantity.** A seat is not metered, so both
answer `FeatureNotConsumable`. `check()` answers from the cap: a quantity with no
cap is always allowed, and one with a cap allows while `quantity + amount <= cap`.

**6. The read model carries the quantity, not a spendable count.** A
non-consumable row has `quantity`, `included` (the free grant), `cap`, and
`remaining = cap − quantity` (or `null`). It has no `billed`, no `priced`, and
`resets: "never"`. A console can say "12 seats (5 included)" from the same row.

**7. A tier change keeps the quantity.** The account keeps what it holds, and a
tier that includes more raises it to the new grant. A tier that includes fewer
does not take seats away; the next period bills them.

## Slices

### 1 — the catalog and the model

Landed. `Feature.kind: "non_consumable"`, `Allowance.prorate`, the quantity
allowance shape and its refusals (`CatalogQuantityKind`, `CatalogQuantityResets`,
`CatalogQuantityField`, `CatalogQuantityPricing`, `CatalogQuantityWithoutPrice`,
`CatalogQuantityCap`, `CatalogQuantityIncluded`, `CatalogRateCardOnQuantity`,
`CatalogProrateOnMetered`), `SetQuantity` / `QuantityChanged`, the standing's
`quantities` / `quantityProrations`, `prorateQuantity`, and the `TrackUsage` /
`Hold` refusal.

### 2 — the charge and the read model

Landed. `ChargeQuantityProration` / `RecordQuantityProrationInvoice` /
`QuantityProrationInvoiced`, the `SetQuantity` and `ChargeQuantityProration`
bindings, the `quantity` / `cap` / `remaining` row, `capacityOf`'s quantity
branch, and the `SetQuantity` command on the tenant Api.

### 3 — the vendor subscription-item quantity

Landed for Stripe. The `Payments` port gains `setQuantity` under a `quantity`
capability: the binding tells the account's provider the new total, the tier and
feature, and whether the difference is `immediate` or `none`. `StripePrices`
declares and creates one recurring seat price per non-consumable feature, and
`Stripe` resolves that price to the subscription item, updates its `quantity`
with `proration_behavior: "always_invoice"` or `"none"`, and returns the invoice
Stripe opened. The `SetQuantity` binding records that invoice on the pending
proration, so `ChargeQuantityProration` finds it billed and does nothing. A
provider without `quantity` (the manual provider, Polar today) keeps the local
proration and the collector opens the invoice. `Stack` refuses a `quantity`
provider that has no seat price for a billable seat.

## Consequences

- **A seat is not a usage event.** It has no `UsageRecorded`, no `billed`, and no
  `priced`; its money is a proration. A report cannot mistake seats for usage.
- **A quantity change is idempotent by the caller's key.** The key is the
  command id and the proration id, so a retry records one change and bills one
  invoice.
- **The period close keeps seats.** A quantity is not a counter, so `UsageReset`
  marks it `kept` and `ClosePeriod` does not move it.
- **The vendor owns the item when it can.** With a `quantity` provider the
  subscription item carries the seat count, so the next renewal bills the new
  quantity without the deployment touching the vendor. The local proration and
  the vendor invoice are one record: the invoice id is on the pending proration.
- **A provider without `quantity` keeps the local path.** The seat change is a
  local proration, and `ChargeQuantityProration` opens the invoice. Nothing is
  silently skipped; the capability decides which path ran.

## Alternatives considered

- **Model a seat as a `resets: "never"` metered allowance and call `TrackUsage`
  with a delta.** Rejected: a seat is not spent, a delta is not the quantity the
  app knows, and a retry with the same delta is a second seat.
- **Model a seat as a flag plus a quantity field.** Rejected: a flag is on or
  off, and the quantity is the whole entitlement; two fields would let them
  disagree.
- **Bill a seat change at the boundary only.** Rejected as the only behaviour:
  a mid-period upgrade is worth the unused fraction, and a customer who removes
  a seat expects the credit then, not a month later. `prorate: "period_end"` is
  available when a deployment wants the other rule.

## What would reopen this

**Licenses and entities.** A pool of seats bought by a parent and assigned to
entities is a different shape: the pool is a quantity, the assignment is an
entity, and an unassigned seat is normal. That needs an entity aggregate, not
another allowance field. **Polar's seat update** is the next vendor
slice: Polar's seat count is subscription-wide rather than per feature, so its
mapping needs a decision about a tier with more than one seat feature before it
can declare `quantity`.
