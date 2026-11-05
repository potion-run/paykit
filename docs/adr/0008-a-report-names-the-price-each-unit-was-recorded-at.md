# 0008 — A report names the price each unit was recorded at

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0003](./0003-the-deploy-provisions-the-vendor.md), [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md)

## Context

ADR 0006 decided that the close pushes the period's billable units to the vendor, and that the
vendor prices them with the same unit price the catalog states. It left one case open: the unit
price can change mid-period.

A `ChangeTier` to a tier with a different `unitPrice` — or any catalog edit that redeploys a
different one — leaves the standing with a new price while `used` is one counter per feature. At the
close, `billableQuantities` returns `max(0, used - included)` and the report is priced at the
standing's price, so the units recorded before the change are billed at the price that replaced
them. Nothing in the log says which unit was priced at which price, because `UsageRecorded` carries
`charge` (money) but not the price identity.

[`spec/PaykitReportSplit.tla`](../../spec/PaykitReportSplit.tla) models the close this needs and
settles two questions before any code: the free grant belongs to the period rather than to the
price, and a report has to be able to name the price it is about.

## Decision

**1. The event carries the price.** `UsageRecorded` gains `unitPrice` — the catalog price the unit
was recorded at — and `billable` — the units of that event past `included`, at that price. Both are
optional, so a log recorded before they existed still decodes. The price is catalog data,
`{ amount, currency }`, never a vendor id, so `decide` still reads no provider and a replay still
reproduces every number.

**2. The grant is consumed in time order, by the event that spends it.** `billable` is computed
against the running `used` in the transaction that records the usage — the same arithmetic
`chargeOf` already does. `included` is therefore spent once per period, by the first units recorded,
whatever price they were recorded at. The close sums `billable` per price; it never has to
re-derive the order, and a hold that settles later is priced by the same rule.

**3. The read model keeps the split.** `FeatureEntitlement.priced` is
`Record<priceKey, { unitPrice, quantity }>`, folded from the events and reset by `UsageReset` for an
allowance that resets — kept for one that does not, exactly as `used` and `billed` are.

**4. One report per period, carrying a line per price.** `Payments.reportUsage` takes
`lines: ReadonlyArray<{ feature, unitPrice, quantity }>` instead of `quantities:
Record<feature, number>`. `commandId` stays the period, so a redelivery and a retry are still the
same report to the vendor rather than a second quantity.

The alternative — one report per `(period, price)` with a price-qualified command id — also works,
and it was modelled first. It was rejected because it moves the idempotency guarantee from "the
payload is a function of the period" to "the key is a function of the period and the price", and a
caller that forgets the second half gets a silent loss: the second report dedupes into the first and
its units vanish, with nothing to see but a shorter invoice. One report is also what the providers
already want: `StripePrices` names one meter per feature, so two reports would land on one meter
anyway.

**5. A provider that cannot price a line refuses.** The line carries the catalog's `unitPrice` so a
binding can resolve its own metered price. A binding that does not recognise one fails
`PaymentDeclined`; a provider without `usage` fails `ProviderCapabilityMissing`. Neither silently
meters at the standing's price, which is the bug this ADR exists to remove.

## What this did not fix, and what did

A price change was only reachable mid-period while the account was still inside the *new* tier's
`included`: `ChangeTier` refused a downgrade below what was already used, and that check applied to a
billed allowance as well as a blocking one. So a period could bill at two prices only where the first
price billed nothing.

[ADR 0009](./0009-only-a-blocking-allowance-refuses-a-move-below-its-usage.md) narrows that rule to
the case it was written for — an oversubscribed *blocking* allowance — and a mid-period price change
now reaches the standing. This ADR removed the report's dependency on that rule; 0009 is the rule.

## Slices

### 1 — the event, the view and the report

Landed. `UsageRecorded.unitPrice` / `.billable`, `unitPriceKey`, `FeatureEntitlement.priced`,
`billableLines`, and `Payments.reportUsage` taking `lines`. The close groups the period's recorded
billable units by the price each was recorded at and sends one report containing all of them. The
story `reports a unit at the price it was recorded at` drives a mid-period `ChangeTier` through the
close and asserts the line names the new price.

### 2 — the vendor binding resolves a line

`StripePrices` / `PolarPrices` name a metered price per `(tier, feature)` today, so a mid-period
price change is a replacement under one lookup key: the retired price is archived and the new one
answers. Feeding the vendor one usage line per price therefore still lands on one meter, and the
split only pays off where a provider can hold two prices for one feature at once. That is a
per-provider question with a per-provider answer, which is why the port carries the price and the
binding decides.
