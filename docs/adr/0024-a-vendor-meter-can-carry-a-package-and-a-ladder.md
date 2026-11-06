# 0024 — A vendor meter can carry a package and a ladder

- **Status:** Accepted
- **Date:** 2026-11-07
- **Follows:** [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md), [0008](./0008-a-report-names-the-price-each-unit-was-recorded-at.md), [0022](./0022-the-catalog-states-the-price-the-schedule-and-the-rate-card.md)

## Context

ADR 0022 made a package (`$5 per 1,000`) and a graduated or volume ladder
expressible in the catalog and enforceable in the local ledger, but left the
vendor half open: `StripePrices` and `PolarPrices` provisioned a one-rate
metered price, and `validateProviderMappings` refused a banded or packaged
pricing on a provider with `usage`. A catalog could state the price and a local
standing could enforce it, but a deployment could not sell it.

Both vendors can hold the richer shape. Stripe has `transform_quantity` on a
per-unit price (`divide_by`, `round`), and `billing_scheme: "tiered"` with
`tiers_mode: "graduated" | "volume"`. Polar embeds either a `metered_unit` price
with a decimal unit amount or a `metered_tiers` price with a `tiers.type`.

## Decision

**1. A provider declares the whole pricing.** `MoneyProvider.usagePrices` is
the full `Pricing` per tier and feature; the one-rate `unitPrices` map stays as
the shorthand and for state recorded before it existed. `ProviderDescriptor`
carries both, and `Stack` compares `pricingKey` against the catalog's
`pricingOf`, so a package size, a ladder or a band's rate is a deploy refusal
when it differs.

**2. The deploy maps the shape, not the price.** `StripePrices` uses
`transform_quantity` for a package and a tiered price for a ladder. A price
Alchemy's `Price` cannot state is reconciled by `MeteredPrice`, the package's
own resource over the distilled Stripe client; the lookup key remains the
identity, and a changed pricing transfers the key onto a new price. Polar
writes a `metered_unit` price with the per-unit decimal for a package and a
`metered_tiers` price for a ladder. The local ledger and the vendor invoice
both start from the same catalog `Pricing`.

**3. The close still pushes quantity.** A report line carries the billable
units and the rate they were recorded at. Stripe's transform and both vendors'
tiers apply the catalog's arithmetic to the meter total; paykit never sends
money to a meter. A mid-period change keeps the existing per-price report and
line identity.

**4. A tier change resolves in the standing's currency.** `planChangeTier`
looks a tier up in the currency the standing was sold in, not the tier's base
currency. The admin quote and the preview call the same plan, so an EUR
standing moving to an EUR-sold tier no longer resolves the USD price and
refuses itself with `CurrencyMismatch`.

## Consequences

- **A package is a transform and a ladder is tiers.** The catalog's `units` is
  not flattened into a fractional rate where the vendor has a native transform;
  where a vendor prices one unit at a time (a metered tier with a package
  inside a band), the per-unit decimal is the compatible spelling and the
  local ledger keeps the package rounding.
- **`usagePrices` is the deploy contract.** A provider that can only hold one
  rate still maps `unitPrices`; a provider that can hold a ladder maps the full
  pricing. A missing mapping is `CatalogPriceMismatch`, never a meter at the
  wrong rate.
- **Retention still wins.** A changed price is a new Stripe price or a new
  Polar product generation; the retired one stays for the invoices that
  reference it, and the archive sweeps remain the only thing that deactivates
  or archives.
