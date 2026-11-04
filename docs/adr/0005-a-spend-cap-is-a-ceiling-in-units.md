# 0005 — A spend cap is a ceiling in the feature's own unit

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** the `cap` row of [0001](./0001-catalog-states-the-pricing-model.md) §Slice 1
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0002](./0002-credits-are-the-unit-of-account.md)

## Context

ADR 0001 put a spend cap in the catalog as `Allowance.cap: { amount, currency }` — a money ceiling:
"bill overage, but never past $500 this month". The shape does not survive contact with two rules this
package already keeps.

**The catalog carries no unit price.** A tier states what a subscription costs; it does not state what
one extra message costs, because that is the provider's meter and the vendor's invoice. Without a unit
price, `decide` cannot convert units into money, and a money cap would need either a price per feature
in the catalog — undoing the separation the whole model is built on — or a provider read inside
`decide`, which is the one thing the entitlement plane refuses.

**`decide` is pure and sees only the standing.** It knows `included`, `used`, `reserved`, `remaining`
and captured rates. A cap it cannot compute is a cap it cannot enforce.

## Decision

**1. A cap is expressed in the feature's own unit: `Allowance.cap?: Int`.** It is the maximum number
of units a period may bill *past* `included`, so the ceiling is `included + cap` units of that
feature. "2,000 messages included, bill up to 10,000 more, then stop" is one field.

**2. A cap only exists where billing does.** `cap` requires `overage: "bill"`: on `"block"` the
allowance already stops at `included`, and on `"allow"` nothing is ever billed, so a cap would be a
number with no effect. The catalog refuses `cap` anywhere else (`CatalogCapWithoutBilling`), including
on an unlimited allowance, which defaults to `"allow"`.

**3. The ceiling counts what is used and what is held.** `used + reserved + amount > included + cap`
is `SpendCapExceeded { feature, cap, used, reserved, requested }`, from `Track` and from `Hold`
alike — a hold is a promise to bill, so it counts against the cap in the same transaction that would
have recorded the usage.

**4. The cap resets with the period**, because `used` does. Nothing else has to remember it.

**5. Money caps arrive with postpaid pricing, not before.** The moment the catalog states a unit
price — the postpaid slice of ADR 0001 — a cap can also be stated in money, as a derived ceiling
(`cap.amount / unitPrice`). That is a change to what the catalog can express, and it gets its own
record when there is a price to divide by.

## Slices

### 1 — the ceiling

| Piece | Change |
| --- | --- |
| Catalog | `Allowance.cap?: Int` with a positive check; `allowance(…, { cap })`; `CatalogCapWithoutBilling` when `overage !== "bill"` |
| `decide` | `Track` and `Hold` refuse past `included + cap` with `SpendCapExceeded` |
| `check()` | not allowed once the next unit would pass the ceiling |
| Read model | `FeatureEntitlement.cap?`, so a console can say "2,000 of 12,000 used this period" |
| Example | `pro` bills up to a cap, so the shape is exercised by a subscriber the suite sells to |

### 2 — the console

A capped feature shows headroom, not just remaining, because "remaining" at a billing tier is not the
number a customer asks about.

## Consequences

- **A cap is not a spending limit in money**, and the docs must say so: it limits quantity, and the
  money that quantity costs is the provider's price times the units billed. A user who wants a
  money cap gets one when postpaid pricing lands.
- **`included + cap` is per period.** A cap does not accumulate, unlike a carried allowance; a quiet
  month does not earn a louder one.
- **Holds count.** A caller cannot hold past the cap and settle into a bill it was never allowed to
  run.
- **A capped feature answers `allowed: false` at the ceiling while its standing is still `good`.**
  That is correct — the account is not in trouble, it has used what it bought — and `check()` must
  not confuse the two.

## Alternatives considered

- **Money cap with a unit price in the catalog.** Rejected for now: it puts the vendor's meter in the
  catalog and makes `decide` depend on a price the deploy, not the model, owns. Postpaid pricing is
  where that price legitimately enters.
- **Cap in credits only.** Rejected: credits are for features priced in credits; a counted feature
  has no currency to cap in.
- **A cap that blocks at the ceiling but still records usage.** Rejected: the ceiling exists to stop
  the spend, and recording past it records a charge nobody agreed to.
- **A soft cap that warns and bills on.** Rejected as a model rule: alerts belong to the console, not
  to `decide`, which has no channels to send them.

## What would reopen this

Postpaid pricing. Once a feature states a unit price, a money cap is a ceiling divided by a price,
and the catalog can express what a buyer asks for in the words they ask for it.
