# 0035 — Plans, plan items, customers and balance sources are the public API

- **Status:** Accepted
- **Date:** 2026-11-10
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0015](./0015-a-runtime-binding-names-a-command.md), [0023](./0023-a-seat-is-a-quantity-that-is-set.md), [0034](./0034-one-quint-model-per-protocol.md)

## Context

The runtime surface is a command list: `Subscribe`, `ChangeTier`, `ScheduleTierChange`,
`SetQuantity`, `ScheduleCancellation`, `Resume`, then a second money call such as
`ChargeProration` or `ChargeQuantityProration`. A caller has to know which command to use,
whether the move is an upgrade or a downgrade, and when the money is collected. The catalog is
also named after the internal aggregate: `Tier`, `Allowance`, and a single shared `Credit` pool.

That shape cannot express a product with plan groups, add-ons, multiple plan items for one
feature, per-source balances, lifetime grants, rollovers, or a customer-level billing control.
It also leaks the event model: a plan change is not one operation, it is three commands and a
second charge call.

## Decision

**1. The public vocabulary is plan, plan item, customer and balance.**

| Public word | Means | Internal word |
| --- | --- | --- |
| `Plan` | a purchasable product: `free`, `pro`, `annual` | `Tier` |
| `PlanItem` | one line of a plan: a feature, an included amount, a price, a reset, a rollover | `Allowance` |
| `Customer` | the account the deployment bills, with its plans and balances | account standing |
| `Balance` | what a customer can spend of one feature, with its sources | `Entitlement` row |
| `BalanceSource` | where one part of a balance came from: a plan, an add-on, a one-off grant, a rollover or a standalone grant | `prepaidCredits`, plan credits |
| `Entity` | a child scope under a customer, with its own plans and balances | none |

`Tier` and `Allowance` remain internal schema names while the state migrates; the events speak
plan, and the advanced command bindings keep their names. They are not a second public API. `Credit` is not a special field on a plan: a credit system is a `Feature`
of `type: "credit_system"`, and the credits it holds are a balance source like any other.

**2. Two operations replace the command list.** `billing.attach` handles a new plan, an immediate
upgrade, a scheduled downgrade, an add-on and a one-off purchase. `billing.update` handles a
quantity change, a cancellation and an uncancel. Both decide from the current plan set and the
catalog; a caller never chooses the command. `previewAttach` and `previewUpdate` run the same
pure decision without recording it.

`attach` and `update` fold the money step into the operation. A caller does not call a second
verb to collect a proration; the result carries the invoice, the checkout URL or the applied
change. The low-level command bindings remain available as an advanced surface.

**3. A plan has a group and may be an add-on.** At most one active plan per `group`. A move inside
a group replaces or schedules a replacement; a plan in another group, or one marked `addOn`,
stacks alongside. This is what makes add-ons and a default plan expressible without a second
standing.

**4. A balance is a list of sources, not one number.** Each source has a kind, a grant, a
remaining amount, its own reset or expiry, and its own plan or grant identity. The public
`Balance` is the sum plus a `breakdown`. Deduction consumes shorter intervals first, then the
soonest expiry, then lifetime sources. This is the only shape that can answer "what is left, and
where did it come from" for a plan grant, an add-on, a one-off pack, a rollover and a standalone
grant at once.

**5. A plan item owns its reset and its proration.** `reset` is `{ interval, count }`.
`proration` is `{ onIncrease, onDecrease }`, with the amount-change behaviours the product needs:
immediate, next cycle, or none. A single `Prorate` enum is not enough to state a different rule
for adding and removing seats.

**6. Customer-level controls are state.** Auto top-up, spend limits and usage alerts are set on
the customer or entity, with plan values as defaults. They are not catalog-only: a customer can
be granted a different line without a deploy.

**7. A scheduled change never carries a plan allowance.** At the boundary the old plan source is
replaced and the new plan source is granted. Lifetime sources are separate sources and survive.
This is [0037](./0037-a-lifetime-grant-is-a-balance-source.md).

## Consequences

- The `Billing` binding barrel becomes the advanced surface. `@potion.run/paykit/Api` is the
  recommended one.
- `BillingApi` and `BillingAdminApi` expose the two operations and the balance reads, not one
  route per internal command.
- The catalog schema and the standing gain versioned shapes. Old `Tier` state decodes into
  `Plan`; old `credits` and `prepaidCredits` decode into balance sources.
- One account may have several plans. The single-writer-per-account rule stays: one aggregate (or
  one plan collection with one writer) owns every command for a customer.
- The reference product is not named in code, comments, docs or tests. The vocabulary is ours.

## What this does not decide

- A runtime plan editor. The catalog is still deploy-time data.
- Multi-currency tax, invoice PDFs or merchant-of-record duties.
- An entity hierarchy beyond a flat child scope. Nested entities are a later ADR.
