# 0001 — The catalog states the pricing model, and the deploy provisions the vendor

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** none

## Context

Paykit sells two planes: entitlements, which it owns, and money, which the provider owns. The
provider is a port; the catalog is ours.

Today the catalog states three things per feature — `included`, `overage` and `resets` — and one
`price` per tier. That is enough to describe a free tier and a flat monthly or annual one, and
nothing else:

- A product sold by **credits** (a message costs some credits depending on the model that served
  it) cannot be written down.
- A **prepaid** pack, a **postpaid** usage price, a **seat** price and a **rollover** cannot be
  written down.
- An on/off feature has to pretend to be a number (`included: 1`), and an unlimited one has to
  pretend to be finite.
- A **spend cap** — "bill overage, but never past $500 this month" — is not expressible at all.

Meanwhile the money plane's configuration is still manual: prices are created in a vendor's
dashboard, and `Stack` only checks after the fact that the vendor's amount agrees with the
catalog (`CatalogPriceMismatch`). A deployment therefore proves that the two prices *agree*
without ever being the thing that *set* one.

Two shortcuts are available and both are refused, because each removes the property that makes
this library worth using:

- Let a dashboard or an API edit prices at runtime. That has no version and no diff, so two
  environments can disagree about what "pro" costs and neither is wrong.
- Let the vendor own the catalog, so "what does the customer get" becomes a provider read.

What makes this decision possible is the tool under it: a catalog declared beside a stack is
data Alchemy already diffs, validates and records. Expressiveness can be added as *data plus a
pure rule*, which keeps `decide` total and `check()` local.

## Decision

**1. The catalog states the pricing model.** Everything a buyer can be sold is a typed,
declarative value in the catalog: how much is included, what happens past it, what it costs, and
how it is charged. The catalog remains plain data — no provider ids, no HTTP, no clock.

**2. The deploy is the vendor sync.** The products, prices and webhook endpoint a provider needs
are resources reconciled from the catalog by the provider package, not objects a person creates
in a dashboard. The stack creates them, diffs them on the next deploy, and refuses to ship when
they disagree with what the catalog says. `CatalogPriceMismatch` stops being the backstop and
becomes the reconcile's own refusal.

**3. `check()` stays local.** No amount of pricing expressiveness may cost a provider round trip.
Every field added to the catalog must be answerable from the read model alone, because the
entitlement plane's whole claim is one local read.

**4. The refusals hold.** No customer records. No runtime catalog mutation. No per-account
entity balances or second subscription. Expressiveness is added in the catalog, never by
relaxing these three.

### Slice 1 — shapes the catalog cannot express yet

| Shape | Catalog addition | What `decide` answers | What the read model carries |
| --- | --- | --- | --- |
| On/off feature | `Allowance.included: 0 \| 1` with `resets: "never"` is a workaround; add `kind: "flag"` | allowed or not, no counter | `allowed` only |
| Unlimited | `included: "unlimited"` | never blocks; overage is moot | `remaining: null` means unbounded |
| Credits with a rate card | `creditCost` per feature (or per dimension) — a message costs N credits | deducts `amount × cost`, not `amount` | remaining in credits, not units |
| Prepaid pack | a tier that is `one_off` and grants credits once | grants on payment, no period | expiry and balance |
| Postpaid usage | `overage: "bill"` plus a `unitPrice` on the allowance | bills the part past `included`, refuses at a money cap | used this period, billed money, forecast |
| Rollover | `Allowance.carryOver: boolean` | closes a period carrying `min(remaining, included)` | carried amount, visible |
| Spend cap | `Allowance.cap: Int` — a ceiling in the feature's own unit; see [0005](./0005-a-spend-cap-is-a-ceiling-in-units.md) for why it is not money | refuses at the cap, not at the allowance | cap, and the units spent against it |

Each row is a schema field, a `decide` rule and a read-model column. None of them is an API.

### Slice 2 — provisioning from the catalog

`Stripe({ tiers })` and `Polar({ tiers })` gain resources beside their bindings — a price, a
product, a webhook endpoint — reconciled from the same mapping the catalog is validated against.
Two rules:

- **A price is not deleted while a standing was sold at it.** Delete is a retire: the vendor
  price is archived, the accounts on it stay.
- **A drifted price fails the deploy**, naming the tier and the field, before anything is
  charged.

### Slice 3 — ergonomics that follow from the same decision

Not part of this record; each gets its own.

- One atomic lock call instead of three: reserve and settle with an id, so a caller cannot
  check and then forget to hold.
- Outbound events, so an app hears "this account upgraded" without polling the log.
- Console screens that answer a support ticket: balances, usage timeline, why this account is on
  this tier, manual grant, refund.

## Consequences

- **A catalog change old state cannot read bumps `BILLING_STACK_VERSION`**, and `read` refuses a
  version it does not know — the guard added for exactly this. A widening does not bump it:
  `included: "unlimited"` still decodes from a record that holds a number, so refusing that state
  would force a reset for no reason.
- **The catalog becomes the version ledger.** A deploy records what a price was; the log records
  what an account bought. "What was this account paying in March" is answered from events, not
  from a plan-versioning feature.
- **The provider packages grow resources.** `paykit-stripe` and `paykit-polar` stop being pure
  adapters: they own vendor objects now, and a delete path that must not cancel a subscription.
- **Deploys do more work.** Vendor calls at deploy time, which is the one place a price changes,
  and zero calls at request time, which is the trade this library exists to make.
- **Every new field is a decision, not a default.** A catalog field that `decide` ignores, or a
  read-model column nothing fills, is a bug — the conformance suite and `doctor` widen with each.

## Alternatives considered

- **Stay thin.** Rejected: three sellable shapes is not a product, and a buyer who prices by
  usage cannot adopt it at all.
- **Runtime catalog API.** Rejected: no version, no diff, and two environments that disagree
  with no way to say which is right.
- **Vendor owns the catalog.** Rejected: then `check()` needs a provider read, and the
  entitlement plane becomes the money plane with extra steps.
- **Plans as a mutable database table in the user's app.** Rejected for the same reason as the
  runtime API; the deploy is the version.

## What would reopen this

A buyer who needs pricing that cannot be expressed as catalog data plus a pure rule — a
negotiated per-account contract, say. That pushes toward storing per-account terms, which is
customer records by another name, and would be a different product rather than a field here.
