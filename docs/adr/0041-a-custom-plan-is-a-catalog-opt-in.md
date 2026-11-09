# 0041 — A custom plan is a catalog opt-in, and its grants are defaults

- **Status:** Accepted, amended by [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) §1–3 and [0043](./0043-a-custom-plan-may-be-a-groups-fallback.md) §5
- **Date:** 2026-11-11
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md), [0035](./0035-plans-plan-items-and-balance-sources.md), [0038](./0038-customer-controls-are-state.md), [0039](./0039-one-plan-per-group-and-add-ons-stack.md)

## Context

Every plan a customer can hold is a catalog plan, and `CatalogGuard` enforces that literally: a
command's allowances must equal `planItemsOf(catalog, tier)` field for field. That check is what
keeps the log honest about money — `decide` is pure and never sees the catalog, so the terms a
command carries are the only thing standing between a client and an invoice nobody agreed to.

It is also the one thing a host cannot build on top of the library. A negotiated deal — "1,200 seats,
150k messages, $40k a year, everything else like the enterprise plan" — is not expressible. The
`variantOf` / `customize` pair ([ADR 0022](./0022-the-catalog-states-the-price-the-schedule-and-the-rate-card.md))
does not help: a variant is still catalog data, so every negotiated deal would need a deploy, and the
catalog would grow one plan per customer.

[ADR 0035](./0035-plans-plan-items-and-balance-sources.md) already says what a bespoke deal is made
of: a `PlanChanged` carries the allowances it granted, so history stays exact. Nothing refuses a
bespoke standing once it is recorded; what refuses it is the guard at the door. The question is not
whether the log can hold a custom deal — it can — but how a decision to sell one is written down,
checked, and kept.

Two failure modes are easy to pick:

- **A bypass.** The guard stops comparing allowances, and any caller can write any standing. That
  makes every deployment's guard weaker to serve a handful of negotiated deals.
- **A per-customer plan in the catalog.** The catalog stops being a description of what is sold and
  becomes a customer table, one deploy per deal, and the `grants` on a plan stop meaning anything.

## Decision

**1. A plan may declare `custom: true`, and only then may a customer hold bespoke allowances.**
The field is catalog data (`Plan.custom`, schema `Tier.custom`), so the decision to sell negotiated
deals is a reviewed line in `billing.config.ts`, next to the price it applies to. A plan without it
is fixed: its `grants` are exactly what any customer may hold under it, and the guard's rule for it
does not change. The opt-in is per plan and never per request, so a deployment that sells only fixed
plans cannot accidentally accept a bespoke one.

**2. A custom plan states everything a plan states; its `grants` are defaults, not its allowances.**
`price`, `group`, `credits`, `creditsExpire`, `topUp`, `rateCard` and `grants` are all declared and
validated exactly as for any plan. The difference is one sentence: the `grants` are the set a caller
gets when it states none, and the shape every bespoke set is judged against — not the only set a
customer may hold. A custom plan may declare no bespoke grant at all and still be attached with one;
its `grants` are the quote the catalog shows.

**3. The guard accepts a custom plan's allowances structurally, and everything else exactly.**
For a plan with `custom: true`, `catalogMismatchOf` accepts an allowance set when every entry:

- is a declared feature (`CatalogUnknownFeature`, reported as `CatalogMismatch`);
- is stored under its own feature id, so a record key and the item it holds cannot disagree;
- obeys every per-item rule the catalog enforces on its own grants — the same
  `allowanceFaultOf` function `defineCatalog` runs, not a second copy of those rules: a flag is
  granted with `grant()` and a metered feature is counted, a credit-priced feature holds no
  allowance, `"unlimited"` implies `overage: "allow"`, a `cap` and a `unitPrice` need `overage:
  "bill"`, a `moneyCap` needs a price, a carry needs a reset and a boundary, `resetEvery` needs a
  reset, `prorate` belongs to a quantity, and a banded price must be a ladder in the plan's currency;
- is a non-empty set, because a plan that grants nothing could never activate.

Everything else is compared exactly as it is today, for both kinds of plan: the plan exists, the
price matches (including the currency the command states), and `credits`, `creditsExpire`, `topUp`
and `rates` match. A non-custom plan keeps the exact-set rule and its `CatalogMismatch`. A custom
plan's *price* is still the catalog's by default: a bespoke deal changes what a customer is allowed
to use, and a negotiated price is the operation's explicit override ([0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) §3).

**4. The bespoke allowances travel on the command and into the event.** No allowance is looked up
inside `decide`. `Subscribe`, `ChangeTier` and `ScheduleTierChange` already carry `allowances`, and
`SubscriptionActivated`, `PlanChanged` and `PlanChangeScheduled` already record them, so a bespoke
deal is replayed from the log like any other, a catalog deploy never rewrites a deal that was
already sold, and the read model (`BillingState.plans`, `Entitlements`, `Balance`) reports the
allowances the event granted rather than the ones the catalog now states. This ADR adds no event
field and renames none.

**5. A custom plan is base-only.** The catalog refused three combinations when this ADR was written.
[0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) §2 reopens the add-on refusal,
and [0043](./0043-a-custom-plan-may-be-a-groups-fallback.md) reopens the fallback refusal; the pack
refusal stands.

- `custom` on a `kind: "one_off"` pack (`CatalogCustomPack`). A pack grants nothing, so there is no
  allowance to make bespoke.
- `custom` with `addOn: true` (`CatalogCustomAddOn`). An add-on stacks beside every group, and the
  plan set merges allowances per feature with the interim single-source rule
  ([ADR 0035](./0035-plans-plan-items-and-balance-sources.md) §4). A bespoke add-on needs the balance
  ledger to report one source per plan before "how much is left" has an answer; until then a
  bespoke deal is a group's plan.
- `custom` with `isDefault: true` (`CatalogCustomDefaultPlan`). **Reopened and accepted by
  [0043](./0043-a-custom-plan-may-be-a-groups-fallback.md) §5.** `isDefault` is the plan a
  cancellation falls back to ([ADR 0039](./0039-one-plan-per-group-and-add-ons-stack.md) §5), and
  the fallback row is still the catalogue's terms: `defaultPlanFor` resolves it from `planTermsOf`,
  so a cancellation re-grants the catalog's grants, not the bespoke set a customer held. An add-on
  cannot be a group's default (`CatalogDefaultOnAddOn`), because it fills no slot.

A variant inherits `custom` from its base and does not state it: a variant of a custom plan is the
same negotiated plan at another price, and a non-custom base cannot grow a bespoke child.

**6. The public surface is one plan field and one request field.**

```ts
const enterprise = Paykit.plan({
  id: "enterprise",
  custom: true,                        // bespoke allowances are allowed under this plan
  price: { amount: 4_000_000, currency: "usd", interval: "annual" },
  credits: 500_000,
  grants: [Paykit.planItem(messages, { included: 150_000, overage: "bill" })], // defaults
});

yield* attach({ planId: "enterprise", grants: [ ... ], idempotencyKey: requestId });
```

`Paykit.Attach(account)({ planId, grants })` and `previewAttach` take the bespoke items; the
low-level verbs (`Paykit.Subscribe`, `Paykit.ChangeTier`, `Paykit.ScheduleTierChange`) take the same
optional `grants`, because they are the same catalog join (`TierCommand.withGrants`) and a caller
must not have to reach for the command classes to get one. `grants` is an array of plan items, the
shape a plan declares, folded to the allowance record the command carries, with a duplicate feature
refused rather than silently last-wins. Omitting it attaches the catalog's defaults.

A custom plan change is a normal plan move and nothing else: proration from the two prices, a
downgrade scheduled for the boundary, a cancellation that resolves the group, a phase that freezes
the bespoke terms when it is scheduled ([ADR 0039](./0039-one-plan-per-group-and-add-ons-stack.md)
§3). Attaching the **same** plan with a different bespoke set is also a move and not a replay: it is
scheduled at the boundary by default, supersedes the group's waiting phase and lands as an ordinary
`PlanChanged`, which is how a negotiated deal is re-negotiated without moving the customer off it.

**7. A bespoke set cannot cross a hosted checkout.** A priced plan's first activation goes through
the provider, and the activation is rebuilt from the catalog when the webhook lands — the provider's
event names the plan, not the negotiated allowances. A checkout would therefore grant the catalog's
defaults, which is a different deal at the same price. `Subscribe`, `Attach` and `PreviewAttach` refuse
exactly that combination with `PlanOperationUnsupported({ reason: "custom_plan_checkout" })`, before
the provider is asked — the preview included, so a caller is never shown a deal the write would
decline. A bespoke deal is still sold two ways: an immediate move on a live standing (a plan change
with proration, which never touches a checkout), and a phase scheduled for the boundary, whose terms
were frozen when it was scheduled. Carrying quoted terms across a checkout is the next slice; this
ADR records the gap rather than papering it with the catalog's defaults.

> **Amended by [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) §1.** The quote
> now rides the provider reference as a pending activation, and `custom_plan_checkout` is gone.

**8. A later deploy cannot rewrite a deal, and a removed plan does not delete one.** A catalog deploy
changes what the next command may state:

- The plan's id, group and price still validate on every new command against the deployed catalog.
  A price change applies to the next plan move, not to the standing in force. The plan's generation
  is now recorded on the row and the event, so the drift is visible and the next move is the
  migration ([0047](./0047-a-plan-is-versioned-and-a-move-is-its-migration.md)); there is still no
  automatic migration ([BILLING-SURFACE](../BILLING-SURFACE.md)).
- The allowances a customer already holds are history. A changed `grants` list is a changed default
  and quote; it is never diffed against a standing, and a replay still produces the deal that was
  sold.
- A custom plan removed from the catalog leaves its standings alone. `planOf` returns `null`, so
  `Verify` has nothing to judge and `PlanNotInCatalog` refuses the next move to it — the same answer
  a removed fixed plan gets. Deleting a customer's balance to match a catalog would be the
  destruction [ADR 0003](./0003-the-deploy-provisions-the-vendor.md) refuses.

**9. The models do not change.** `specs/paykit/*.qnt` has never held the catalogue, and `decide` is
untouched by this slice: the guard is the boundary in front of the model, and a custom plan is an
ordinary plan whose allowances came from a request instead of a catalog row. No action, invariant,
mutant or command-coverage row is added, because no command and no decision changed.

## Consequences

> [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) removes
> `CatalogCustomAddOn`, and [0043](./0043-a-custom-plan-may-be-a-groups-fallback.md) removes
> `CatalogCustomDefaultPlan`; the pack refusal stands.

- `Plan.custom` is one schema field, and the catalog gained three refusals: `CatalogCustomPack`,
  `CatalogCustomAddOn`, `CatalogCustomDefaultPlan`. [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md)
  removed `CatalogCustomAddOn`; [0043](./0043-a-custom-plan-may-be-a-groups-fallback.md) removed
  `CatalogCustomDefaultPlan` and added `CatalogDefaultOnAddOn`.
- `defineCatalog`'s per-grant loop becomes `allowanceFaultOf`, one function used by both the catalog
  and the guard, so the structural rules cannot drift between what a deploy validates and what a
  bespoke request must satisfy. `catalogFactsOf` derives the declared features, their kinds and the
  credit-priced set from a validated catalog.
- `CatalogMismatch` gains no field. A structural refusal names the plan, the feature, `field:
  "allowances"`, and `actual: <the catalog rule that failed>` — the tag of the rule, so an operator
  can find it in this file. A bespoke item that fails the `Allowance` schema itself is a decode
  failure, not a guard refusal.
- `TierCommand.withGrants` is the one join from a bespoke array to the command's allowance record.
  `CatalogMismatch` is in every binding's error channel that can now produce it, and
  `PlanOperationUnsupported` moves to its own module so the purchase path can raise it without an
  import cycle.
- `AttachRequest`, `PreviewAttachRequest`, `SubscribeRequest`, `ChangeTierRequest` and
  `ScheduleTierChangeRequest` each gain `grants?: ReadonlyArray<PlanItem>`.
- `docs/briefs/custom-plans.md` is the implementation plan; `NEXT.md` and `BILLING-SURFACE.md` move
  the row from missing to shipped when the guard, one attach path and their tests are green.

## Alternatives considered

- **A catalog allowlist of feature sets.** Rejected: it makes the catalog enumerate deals, which is
  the per-customer catalog by another name, and it still needs a deploy per negotiation.
- **A runtime flag on the command (`bespoke: true`).** Rejected: a caller could opt itself into a
  weaker guard. The opt-in has to be the deployment's, and the catalog is where a deployment states
  what it sells.
- **Comparing a bespoke set against the catalog's grants as a subset or a superset.** Rejected: a
  negotiation removes features as often as it adds them, and a subset rule would still forbid a
  feature the plan's price never mentioned. The rule is structural, not relational.
- **Letting the guard accept any allowance and moving the check into `decide`.** Rejected: `decide`
  is pure and cannot see the catalog, and a null check there would be a second catalog in the state.
- **A separate `CustomPlan` resource.** Rejected: a custom plan is a plan. A second type would need
  a second guard, a second join and a second set of reads for one boolean.
- **Refusing the priced attach silently, by attaching the catalog defaults.** Rejected: it records a
  deal the customer did not agree to, which is the one outcome worse than a refusal.
- **Bespoke add-ons in the same slice.** Deferred, with the reason in §5: the plan set's merge rule
  is the blocker, not the guard.
- **Versioning the custom plan's allowances in the catalog.** Rejected: the event log is the version.
  A plan row that disagreed with its event would be two records of one deal.

## What would reopen this

The first three below were reopened and decided by
[0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md).

- **Bespoke add-ons.** Reopening §5 needs the per-plan balance source
  ([ADR 0035](./0035-plans-plan-items-and-balance-sources.md) §4) so a stacked bespoke item has its
  own `Balance.breakdown` row, and a merge rule that says what two bespoke items for one feature mean.
- **A custom plan as a group's fallback.** Reopened and decided by
  [0043](./0043-a-custom-plan-may-be-a-groups-fallback.md): a cancellation re-grants the catalog's
  terms, never a bespoke set, and an add-on cannot be a default.
- **A bespoke deal sold through a checkout.** Reopening §7 needs the quoted terms to ride the
  provider reference (or a pending activation) until the webhook can read them back.
- **Negotiation as a first-class record.** A `CustomPlan` entity with an approver, a source quote and
  an expiry would move the decision out of `billing.config.ts`; that is a deployment workflow, and it
  would need its own event rather than a boolean in the catalog.
- **A price a customer negotiated.** Today a bespoke set changes allowances only. A negotiated price
  is a different resource (a per-account price), and it reopens the "price matches the catalog" half
  of §3 as well as the provider's price objects.
