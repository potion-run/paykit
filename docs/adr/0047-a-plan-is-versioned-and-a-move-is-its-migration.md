# 0047 — A plan is versioned, and a move is its migration

- **Status:** Accepted
- **Date:** 2026-11-13
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0003](./0003-the-deploy-provisions-the-vendor.md), [0010](./0010-a-price-that-leaves-the-catalog-is-archived-not-deleted.md), [0035](./0035-plans-plan-items-and-balance-sources.md), [0039](./0039-one-plan-per-group-and-add-ons-stack.md), [0041](./0041-a-custom-plan-is-a-catalog-opt-in.md), [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md)

## Context

The catalog is deploy-time desired state, and a standing keeps the terms it bought: `SubscriptionActivated`,
`PlanChanged` and `PlanChangeScheduled` carry the allowances, price, credits and rates, so a
catalog deploy never rewrites a subscriber. That rule is already right. What the catalog cannot
say is **which generation of a plan a customer is on**.

`Plan` is an id, a price and a set of terms. "Pro" is both the plan sold today and the plan sold
last March, and a billing page, an operator and a support conversation cannot tell them apart.
Three concrete failures follow:

- **A read cannot see drift.** `Customer.plans` says `pro` and `BillingState.plans.pro` says
  `pro`. Neither says the account is on the plan as it was priced before the last deploy. The
  only way to find out is to replay the log and compare it by hand.
- **A change can miss its record.** A deploy that changes a fixed plan's grants or price without
  changing anything else is invisible: the next `Verify` has nothing to compare, and a caller
  cannot ask "did this deploy change what existing customers hold".
- **An existing subscriber cannot be migrated by the ordinary surface.** `Attach` treats
  `planId === planIdOf(state)` with no stated terms as a replay. A subscriber on the old `pro`
  cannot be moved to the new `pro` without inventing a bespoke set, which makes a catalog change
  look like a negotiated deal.

[BILLING-SURFACE](../BILLING-SURFACE.md) records the gap as "the catalog is versionless; a price
or allowance change is new data, not a migration of existing subscribers". This ADR closes it
without a data migration: the log already holds the terms, and what is missing is a generation
number that names them.

## Decision

**1. `Plan.version` is catalog data, and absent means the first generation.**
`Tier.version` / `Plan.version` is a positive integer; `tier({ version: 2 })` is the second
generation of that plan. The deploy bumps it in the same change that changes what the plan
**sells**: its `grants`, `price` (amount, currency or cadence), `credits`, `creditsExpire`,
`topUp`, `rateCard`, `group` or `addOn`. A variant inherits its base's version and does not state
one: a variant carries the base's terms at another price, so a base generation is the variant's
generation. A one-off pack may state a version too; it is a plan a customer buys, even though it
is never moved onto.

The catalog cannot enforce "you changed the terms, so you must have bumped it" across deploys —
it only sees one desired state, not the previous one. That rule is enforced at runtime by
`Verify`, which compares a fixed plan's recorded terms with the catalog's at the same generation
(§5).

**2. A standing records the generation it bought, and the version is recorded additively.**
Every plan row carries `version` (`PlanRow.version`, and therefore every plan phase). The events
add the field and rename none: `SubscriptionActivated.version`, `PlanChanged.versionBefore` /
`versionAfter`, `PlanChangeScheduled.version`, and `PendingActivation.version` for a quote that
crosses a checkout. The first generation is omitted from an event, the way a default group is:
an ordinary activation does not grow a field, and an event written before the field existed
decodes as generation 1. A state row always writes the number, because it is the row's identity.

**3. A version is not an id.** The plan id, the group, the vendor price object and the event tags
stay the same. The version is a generation of the terms, not a second plan: there is one `pro`,
and the row says which `pro` it bought. The vendor provisioning stays as it is (ADR 0003): a
price change already creates a new price object and moves the lookup key, and a live subscription
keeps the price it was sold. Putting the version into a vendor lookup key would tie the catalog's
generation to one vendor's object identity and make the catalog provider-aware, which
[ADR 0001](./0001-catalog-states-the-pricing-model.md) refuses.

**4. A generation move is an ordinary plan move, and attaching the plan again is the migration.**
The classification gains exactly one rule: a request for the same plan id at the same version is
a replay; the same id at a different version is a move. Everything else is unchanged:

- a move to a more expensive generation is immediate;
- a move to a cheaper generation is scheduled for the boundary unless the caller asks for it now;
- a custom plan's bespoke terms and negotiated price still take the ordinary move path;
- a well-formed move records `PlanChanged` with `versionBefore` and `versionAfter`, and the row
  the event leaves carries the new generation.

There is no separate migration command and no automatic rewrite. An operator moves one account
with `attach`, several with `multiUpdate`, or every account at a boundary with a scheduled phase
— the operations already built. A migration that rewrote a standing from a deploy would be the
destruction [ADR 0003](./0003-the-deploy-provisions-the-vendor.md) refuses, and a price change is
not a fact about a customer.

**5. Reads accept older, refuse newer, and name a missing bump.** `Verify` judges every active
plan row against the catalog:

- `row.version < catalog.version` is `PlanVersionOutdated`: the customer is on an older generation
  and the next move is the migration. It is drift, not an error.
- `row.version > catalog.version` is `PlanVersionAhead`: the running deploy is older than the state
  it serves. Nothing may move the account until the deploy catches up, because recording an older
  generation over a newer one is the one direction a version may never take. `decide` enforces it
  too: a `ChangeTier`, `ScheduleTierChange` or `ChangePlans` move that names an older generation
  than the standing already holds is refused with `PlanVersionStale`.
- `row.version === catalog.version` on a **fixed** plan compares the recorded terms with the
  catalog's (`catalogMismatchOf`, the same rule the guard runs). A difference is
  `PlanVersionDrift({ field })`: the deploy changed the plan without bumping it. A custom plan is
  exempt — its bespoke terms are the deal, not the catalog's — and a plan the catalog removed is
  skipped, because there is no generation to compare it with and deleting it is the destruction
  ADR 0003 refuses.

**6. The guard still checks what reaches `decide`.** `CatalogMismatch` gains `field: "version"`:
a command built from an older generation is refused before it records a deal the deploy no longer
sells under that number. A command written before the field existed is generation 1, so an
unbumped catalog keeps validating the commands it always did.

**7. The model treats a generation as part of the plan.** `specs/paykit/plans.qnt` models a plan as
`{ id, version }`. Its actions are the same ones: `attach` names a generation, a scheduled change
carries the generation it will land on, and the close applies it. The new invariants are the two
the code can check: an active plan or a pending phase never names a generation the catalogue does
not state, and a pending change never names the generation already active (a generation move is a
change, not a no-op). The catalogue-drift rule is a `Verify` rule, not a model invariant: the
model has no previous deploy to compare with.

## Consequences

- `Plan.version` / `Tier.version`, `INITIAL_PLAN_VERSION`, `planVersionOf(catalog, planId)`.
- `PlanRow.version`, `PlanPhase.version`, `CustomerPlan.version` and `BillingState.plans[].version`
  (the `Entitlements` plan rows carry it too, because they share `PlanRow`).
- `SubscriptionActivated.version`, `PlanChanged.versionBefore` / `versionAfter`,
  `PlanChangeScheduled.version` and `PendingActivation.version`; absent means 1.
- `planRedealOf(catalog, row, { grants, price })` is the one rule for "is attaching this plan a
  replay or a new deal". `Attach` and `PreviewAttach` call it; it is exported because it is the
  classification, not an implementation detail.
- `CatalogMismatch` can name `field: "version"`.
- `PlanVersionOutdated`, `PlanVersionAhead` and `PlanVersionDrift` join `VerifyMismatch`;
  `PlanVersionStale` is the command refusal for a backwards move.
- `plans.qnt` gains generations; its scenarios gain a scheduled version move, an immediate one, a
  boundary landing, the same-generation no-op and an unknown-generation refusal. `spec-mutants`
  gains one mutant for the generation bound.
- The cross-account `BillingReadRow` keeps `tier` and does not gain a plan-version column. A
  projection column would need a `billing_rm_*` migration for a descriptive field, and the
  per-account view plus `Verify` already answer the question. A list that must show generations
  reads the view; if that becomes a real need, it is a projection version bump, not a rewrite of
  an existing table.
- `BILLING-SURFACE` moves "Versioning plans" from partial to shipped, and `NEXT` moves the queue
  item to landed.

## Alternatives considered

- **A versioned plan id (`pro@2`).** Rejected: it breaks every plan id already in the log and in a
  provider's lookup key, and it turns one plan into a family. The id is the thing that must stay
  stable; the generation is the thing that moves.
- **A catalog that keeps every version and resolves by `(id, version)`.** Rejected: the catalog is
  deploy-time desired state, not a history. The event log is the history, and a deploy that no
  longer knows a generation is exactly what `PlanVersionAhead` is for.
- **An automatic migration on deploy.** Rejected: it would rewrite a standing, reprice a period
  the customer already paid for, and make a deploy a writer of customer state. The ordinary move
  already carries proration, scheduling and the event.
- **A `PlanVersion` resource or a separate version service.** Rejected: a version is a field on a
  plan and a field on a row. A lifecycle would need a provider, a diff and a delete for something
  that never exists on its own.
- **Versioned vendor lookup keys.** Rejected: it makes the catalog generation part of a vendor's
  object identity. Stripe prices are already immutable and a live subscription keeps its price;
  Polar embeds the price in the product. The vendor's provisioning rule is unchanged.
- **A version in `BillingReadRow` in this slice.** Rejected for now: it is a read-model column and
  a migration, and the per-account path already answers it. Recorded above as a deliberate gap.
- **Refusing a move to the same plan id when the version changed.** Rejected: that is the
  migration. The replay is specifically the same id **and** the same version.

## What would reopen this

- **A plan version that must be approved or quoted before it is sold.** That is a deployment
  workflow and a record of its own, not a field on the catalog.
- **Keeping several generations sellable at once** (grandfathering: new customers keep getting v1
  while v2 is prepared). The catalog would need an active-generation pointer and the move would
  need to state which generation it buys, which is a different classification.
- **A version that changes the provider's object identity** — a new product rather than a price.
  That reopens §3 and needs the vendor packages to own the generation.
- **A migration run with a progress record** ("every v1 account moved, with the failures"). That
  is a deployment job over `Attach`, not a model rule; it would read `PlanVersionOutdated`.
- **A consumer whose backfill plan depends on the plan generation.** The model would need to feed
  the generation into the consumer's target id, the way a changed view version does.
