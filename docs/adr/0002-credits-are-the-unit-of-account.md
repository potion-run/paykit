# 0002 — Credits are the unit of account, and the catalog prices them

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** none
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md)

## Context

The catalog can grant a number of units of a feature. That describes a product where every unit
costs the same: a message is a message. The products people actually sell price the *same* unit
differently depending on what served it — a small model call is one credit, a large one is ten —
and sell the currency itself: "1,000,000 credits for $99, use them whenever".

`credits` exists in the model today, but it is not that currency. It is a single account balance
that an admin tops up with `GrantCredits`, a session spends with `ConsumeCredits`, and a period
close wipes out with `CreditsExpired`. Nothing connects it to a feature, `check()` never reads it,
and nothing converts a unit into it. It is a goodwill balance, not a meter.

Three shapes are therefore unreachable: a feature priced in credits, a rate card that prices the
same feature differently by dimension, and a prepaid pack that sells credits on their own.

## Decision

**1. Credits are a unit of account, chosen per feature.** A feature either counts in its own units
as today, or declares a rate in credits. When it declares one, credits are what is spent and what
`remaining` means.

**2. One pool per account.** Credits are not per feature. A feature priced in credits draws on the
account's balance, and every such feature reports that same balance as its `remaining`, because
that is the truth: they share it. Per-feature pools would be a second and third currency, and a
`check()` that had to sum them.

**3. The rate card is catalog data.** A credit-priced feature carries
`creditRates: Record<string, Int>` — credits per unit, keyed by a dimension the caller names — and
a `"default"` entry is required. A rate is an integer, like every other amount in this package.

**4. `Track` is the only spender.** Recording usage of a credit-priced feature spends
`amount × rate` and puts both the cost and the balance after it on the event, so the pool is a
fold like every other counter and a replay reproduces it exactly. `ConsumeCredits` stays, but for a
manual spend by an operator, not as the metering path.

**5. Expiry is a property of the grant, not of the period.** A tier states
`creditsExpire: "period" | "never"`. `"period"` keeps today's behaviour exactly, so the default is
not a silent change. `"never"` is what a prepaid pack will use.

**6. `check()` answers from the pool.** For a credit-priced feature it is still one local read:
remaining is the balance, and the amount asked for is multiplied by its rate before comparing.

## Slices

### 1 — the rate card

| Piece | Change |
| --- | --- |
| Catalog | `Feature.creditRates?: Record<string, Int>`; required `"default"` when present, every rate a positive integer |
| Tier | `credits?: Int` and `creditsExpire?: "period" \| "never"` |
| `Track` | accepts an optional `dimension`; on a credit-priced feature spends `amount × rate`, and the event carries `cost` and `creditsAfter` |
| Holds | `Reserve`/`Settle`/`Release` on a credit-priced feature refuse with `CreditHoldUnsupported` — holding credits is slice 1b |
| `check()` | `remaining` is the pool; `amount × rate` is what is compared |
| Read model | `FeatureEntitlement` for a credit-priced feature carries the rate used and the shared balance |

Refusals, all at the deploy: a credit-priced feature with an `included` allowance
(`CatalogCreditFeatureHasAllowance`), an allowance naming a feature that is priced in credits
(`CatalogAllowanceOnCreditFeature`), a rate card with no `"default"`
(`CatalogCreditRateMissing`), and a non-positive rate (`CatalogCreditRateInvalid`).

### 1b — holds on credits

A reservation against a credit-priced feature holds *credits* from the shared
pool, so the pool needs a reserved count as well as a balance, and settle
converts a hold into a `UsageRecorded` carrying its cost. Until then the three
hold commands refuse on a credit-priced feature rather than pretending to hold
units that do not exist.

### 2 — prepaid

A one-off tier grants credits with `creditsExpire: "never"`. Buying it is a purchase, not a
period, so it needs a `one_off` tier and a grant that survives a period close — the shape
already allowed by `creditsExpire`.

## Consequences

- **A credit-priced feature has no counter of its own.** Its `remaining` is the account's balance,
  and two credit-priced features report the same number. A console must say "shared balance", not
  "remaining for this feature".
- **`Allowance` and a rate card are mutually exclusive per feature.** An allowance is a count in
  the feature's own unit; a rate card is a price in another. Allowing both would put two counters
  behind one name.
- **`CreditsExpired` becomes a policy outcome**, not a constant: it fires only for grants that say
  `"period"`.
- **The event log carries the price.** `cost` on every metered event means replaying the log
  reproduces the balance even after a rate changes in the catalog — the same rule prices already
  follow.
- **Migration of meaning.** Today's `credits` field is a goodwill balance; after this it is the
  pool a plan meters against. Nothing is deployed, so the two meanings do not have to coexist.

## Alternatives considered

- **A credit pool per feature.** Rejected: it makes a prepaid pack impossible to spend across
  features, which is the whole point of selling credits.
- **Credits as a discount applied to an invoice.** Rejected: that is the vendor's arithmetic, and
  `check()` would no longer be able to answer from local state.
- **Let the vendor meter credits.** Rejected: a provider round trip in the entitlement plane.
- **Floats or cents for rates.** Rejected: money and counts are integers here, and a fractional
  credit is a rounding argument nobody wins.

## What would reopen this

A product that needs per-feature credit pools *and* a shared pack — a marketplace where each
seller's credits are theirs. That is a second dimension on the balance (pool id), not a different
decision; it would extend this record rather than replace it.
