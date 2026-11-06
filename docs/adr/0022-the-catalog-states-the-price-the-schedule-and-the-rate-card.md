# 0022 — The catalog states the price, the schedule and the rate card

- **Status:** Accepted
- **Date:** 2026-11-06
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0005](./0005-a-spend-cap-is-a-ceiling-in-units.md), [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md), [0008](./0008-a-report-names-the-price-each-unit-was-recorded-at.md)

## Context

ADR 0006 made postpaid usage a single unit price on an allowance, and its
"What would reopen this" named the case it could not state: a tier that bills
usage at graduated or volume rates. Four other shapes were also unexpressible,
and each one is ordinary pricing rather than an exotic one:

- **A package price.** `$5 per 1,000 calls` is not a unit price in minor units:
  one call costs half a cent, and the schema has no integer for it.
- **A rate that depends on the event.** `creditRates` is a map from a
  caller-supplied dimension to one flat integer. A large machine, a region and a
  spot discount are properties of the event, not names the caller has to
  translate.
- **A reset the period does not own.** `resets` was `month | annual | never`, so
  a daily allowance on a monthly plan was impossible; the only boundary the
  aggregate owned was the period.
- **A plan sold in more than one currency.** `Price` has one currency, so an
  annual plan and its EUR price are two unrelated tiers.

The model was also carrying a lie: `carryOver` is a rolling cap, not a one-period
rollover, and there was no way to say how much may carry.

## Decision

**1. A price is a cumulative function of the billable count.** `Pricing` is a
union of `unit`, `graduated` and `volume`. `priceOf(pricing, n)` is the money for
`n` billable units, and one event's charge is `priceOf(after) - priceOf(before)`.
The difference is what makes the order usage arrives in irrelevant, and it is
the same arithmetic for a package price (`ceil(n / units) * amount`), a ladder
(the sum of each band's overlap) and a volume price (the band the total lands
in). `UnitPrice` gains `units`, the number of feature units one amount buys.

**2. An event records the lines, not only the total.** `UsageRecorded.priced`
carries one `PricedLine` per price the event crossed: the price's identity, the
quantity and the money. `charge` is their sum, `billable` is the quantity, and
the read model's `priced` folds them. A report can still name one `unitPrice`
when the pricing has one; a ladder has no single price, so the line list is the
only honest form.

**3. A rate card prices on the event's properties.** `RateCard` is `default`,
`dimensions`, `rules` and `multipliers`. A named dimension is a direct lookup; a
matching rule overrides it; every matching multiplier applies
(`rate × factors + adds`), clamped at zero. `Feature.rateCard` is the full form,
`Feature.creditRates` stays the shorthand and is compiled into a card, and
`Tier.rateCard` replaces one feature's card for that tier. `TrackUsage` and
`Hold` take `properties`; the chosen rate is captured on the hold and the event,
so a catalog change mid-flight does not reprice work already priced.

**4. A reset has a schedule, and the period owns only some of them.** `resets`
gains `hour`, `day`, `week`, `quarter`, `semi_annual` and `annual`, and
`resetEvery` counts intervals. A monthly or annual allowance with `resetEvery: 1`
is the standing's period; everything else runs on its own boundary. The standing
carries `resetAt` per feature, `ResetAllowance` closes one window, `AllowanceReset`
records the outcome, and `AllowanceRollover` schedules the next boundary. A
period close resets only the allowances whose boundary it is; an independent
allowance is `kept` by that close and reset by its own command.

**5. A carry has a cap.** `carryCap` bounds what one window may carry; absent
means `included`. The carry is still a rolling cap rather than a fixed number of
windows — the amount that survives is the unspent part of the last window, and a
window that spends it all carries nothing.

**6. A variant is a named alternative of a base tier.** `variantOf` plus
`customize` (or the variant's own fields) states only the differences; the
catalog resolves the variant into a full tier before validation, so the runtime,
the guard and the vendor provisioning never see a partial tier. A missing base
and a cycle are refusals, not runtime surprises.

**7. A tier can be sold in more than one currency.** `Price.additionalCurrencies`
states each amount explicitly; no exchange rate is applied. `priceFor` resolves
the currency a caller asks for. A tier with postpaid prices sells in one
currency: a metered unit price is stated once, and a second currency for the
base price would meter usage in the first one without saying so.

## Slices

### 1 — the price and the ledger

Landed. `Pricing.ts` (`priceOf`, `chargeOfPricing`, `pricedLines`, `priceKey`,
`pricingKey`), `Allowance.pricing` / `UnitPrice.units`, the catalog refusals
(`CatalogPricingWithoutBilling`, `CatalogPricingConflict`, `CatalogPricingBand`,
`CatalogVolumeRateRises`, `CatalogPricingCurrency`), `UsageRecorded.priced`, the
standing's `chargeOf` using the cumulative function, the read model's `pricing`
and `priced`, and the close report already reading one line per price.

### 2 — the rate card

Landed. `RateCard`, `RateRule`, `RateMultiplier`, `creditRateOf`, the
`rateCard` compiler for the shorthand, `Tier.rateCard`, `properties` on
`TrackUsage` and `Hold`, and the tier's effective cards via `ratesOf`.

### 3 — the schedule and the carry

Landed. `resetEvery`, the full `Resets` set, `periodTiedReset`, `nextResetAt`,
`resetAt` on the standing and the read model, `ResetAllowance` /
`AllowanceReset`, `AllowanceRollover`, and `carryCap`.

### 4 — variants and currencies

Landed. `variantOf` / `customize` resolution in `defineCatalog`,
`additionalCurrencies`, `priceFor`, and the duplicate-currency refusal.

## Consequences

- **The event is the bill's unit.** A replay recomputes `charge` from the event's
  own lines; a catalog change cannot reprice history. A report that can name one
  price still does; a ladder names every line.
- **A banded price is a local bill until the vendor learns it.** Superseded by [ADR
  0024](./0024-a-vendor-meter-can-carry-a-package-and-a-ladder.md): `StripePrices`
  and `PolarPrices` now provision the package transform and the metered tiers, and
  `usagePrices` is the provider contract.
- **An independent reset is a command, not a timer.** `decide` still reads the
  clock from its context; a reset that is not due records nothing, and a replay
  of the schedule is the same chain.
- **A volume ladder can reprice a period downward.** The delta is signed, so a
  crossing may reduce the period's `billed`. That is the vendor's own volume
  semantics; a catalog that wants a floor states a `moneyCap`.
- **A variant is resolved at deploy, not at activation.** The standing and the
  guard carry the full tier, so grandfathering is still "the catalog changed, the
  standing did not".

## Alternatives considered

- **One flat price with a divisor on the event.** Rejected: a divisor can express
  a package but not a ladder, and it would make the report's price identity a
  function of two fields.
- **A list of prices on the allowance, keyed by dimension, for rules and
  multipliers.** Rejected: a match is a predicate over properties, not a name;
  keeping it a name would push the matching into every caller.
- **Reset every allowance at the period close and let a policy rewrite the
  counters.** Rejected: a daily allowance would reset monthly, and a policy that
  rewrites counters after the fact is a second writer.
- **A fixed number of windows for a carry.** Rejected for now: the amount that
  survives is the unspent part of the last window, so a window count without a
  vintage ledger would be a field the model cannot honour.

## What would reopen this

A vendor that can hold a tiered price and a meter that sends quantity rather
than money would let `StripePrices` / `PolarPrices` provision a ladder instead
of refusing it. A price that depends on a property the event does not carry
would need a second event field, not another rate shape.

## What this does not cover

**Prepaid quantities and non-consumable seats.** A seat is a quantity that is
bought, prorated on change and synced with `set_usage`; a prepaid feature is a
quantity bought upfront. Both are a new command family and a new state field,
not another price shape. **Named credit pools** are the same question for
credits: one pool per account is a non-goal in `PLAN.md`, and a named pool would
need a pool id on every event, hold and read model. **Per-customer billing
controls** (spend limits, windowed usage limits, alerts) are standing data, not
catalog data; they belong on the standing, not in this record.
