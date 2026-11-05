# 0006 — Postpaid usage is a unit price in the catalog

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0005](./0005-a-spend-cap-is-a-ceiling-in-units.md)

## Context

The last row of ADR 0001 is still unexpressible. `overage: "bill"` says a period may bill past
`included`, and `cap` says how many units it may bill, but the catalog never says what a billed unit
costs. ADR 0005 therefore had to define a cap as a count: with no unit price, a money ceiling cannot
be computed locally.

This is the row that crosses the model into the money plane. It is also what makes "1,000 API calls
included, then $0.002 each" a catalog declaration instead of an invoice someone assembles by hand.

## Decision

**1. A unit price is catalog data on the allowance.** `Allowance.unitPrice` is
`{ amount, currency }` — integer minor units and one currency — and `Allowance.moneyCap` is an
integer minor-unit ceiling. A unit price requires `overage: "bill"` (otherwise no unit is ever
billed); a money cap requires a unit price. Both are refused at the deploy, like every other
catalog shape. A tier's unit prices share one currency, and that currency must match the tier's
`price` when it has one.

**2. `decide` prices the billable part of one event.** The billable units are only the part of
`amount` beyond `included`:

```
before = max(0, used - included)
after  = max(0, used + amount - included)
charge = (after - before) × unitPrice.amount
```

`UsageRecorded` carries `charge` and the feature's `billedAfter`, so the period's money is a fold of
the event log. A replay reproduces it; a catalog change never reprices usage already recorded.

**3. A money cap is per feature and per period.** `billed + charge > moneyCap` refuses the same
transaction with `MoneyCapExceeded`, carrying the cap, what is billed, and the charge that did not
fit. A quantity `cap` still exists; when a tier states both, the stricter one binds. `allowed: false`
at a money ceiling is the account running out of what it bought, not a standing change.

**4. `check()` prices before it answers.** It computes the same charge for the requested `amount`
from the read model's `used`, `included`, `unitPrice`, `billed` and `moneyCap`. The entitlement
plane still answers from one local read.

**5. The period's billed money is reset by `UsageReset`, and the log is the record.** State carries
`billed` per feature so `decide` and `check` can answer; the events carry every charge, so the next
period starts at zero without erasing the audit trail.

**6. The money plane pushes the period's usage at close.** The vendor's metered price uses the same
unit price; a provider mapping that disagrees is a deploy refusal (the same shape as
`CatalogPriceMismatch`), never a runtime conversion. A provider that cannot report usage answers
`ProviderCapabilityMissing`; nothing silently bills only in local state.

## Slices

### 1 — the catalog and the local ledger

Landed. `Allowance.unitPrice` / `moneyCap`, the catalog refusals (`CatalogUnitPriceWithoutBilling`,
`CatalogMoneyCapWithoutUnitPrice`, `CatalogUnitPriceCurrency`), `UsageRecorded.charge` /
`billedAfter`, the standing's `billed` record, `MoneyCapExceeded`, `check()` and the read model's
`unitPrice` / `moneyCap` / `billed`, the period reset, and tests for the arithmetic, the cap, the
close and replay. The `TrialStarted` event now carries the standing's `currency`, because a free
tier can have postpaid prices without a tier price.

### 2 — the vendor meter

Landed. `StripePrices` / `PolarPrices` provision a metered price and meter from the same unit price;
`Payments.reportUsage` (Stripe meter events, Polar metered usage) is declared by providers that have
it, under a `usage` capability; the `PeriodCloseUsage` policy sends the closing period's billable
quantities (`used - included`) with the period as the idempotency key. `Memory` and the vendor
fakes run in every suite, and the provisioning live cases are gated on a vendor key.

## Consequences

- **The catalog now states money on a feature.** That is the first exception to "an allowance is a
  count, never money": the count is still in the feature's unit, and the unit price is what the
  vendor charges for the billable part. The two are separate fields so a console can say "2,400 of
  2,000 included, 400 billable at $0.002".
- **A cap can be money without changing what a cap is.** The quantity ceiling and the money ceiling
  are independent; ADR 0005's "a cap is a count" remains true for `cap`, and `moneyCap` is the new
  money ceiling.
- **A provider read is still forbidden in `decide`.** The unit price travels on the allowance, so
  the pure decision has everything it needs.
- **The close pushes units, not money.** The vendor applies its metered price to the billable
  quantity; `billed` stays a local fold, and the invoice is the vendor's, not a second paykit read.
- **A catalog change can move tomorrow's bill, never yesterday's.** The charge is on the event, and
  a replay keeps it.

## Alternatives considered

- **Price every unit, not just the overage.** Rejected: `included` already means the free part; a
  price on all units would make the free grant meaningless and disagree with the vendor's invoice
  unless the vendor also had a free tier.
- **Put the unit price on the feature instead of the allowance.** Rejected for now: the catalog
  already prices a feature per tier through its allowance, and a global price would make one tier's
  price bleed into another's. A feature-level default can be added later without changing this
  record.
- **Let the vendor meter be the only truth.** Rejected: `check()` and a money cap must answer
  locally; the vendor is the invoice, not the entitlement.
- **Read the unit price from the provider at `Track`.** Rejected: a provider round trip in the
  enforcement path, and a bill that changes under a retry.

## What would reopen this

A tier that bills usage at **graduated** or **volume** rates — the first 10,000 units at one price,
the next at another. `unitPrice` is a single rate; tiers would be a list of bands and a similar
decision for the vendor mapping.
