# 0043 — A custom plan may be a group's fallback

- **Status:** Accepted
- **Date:** 2026-11-13
- **Follows:** [0039](./0039-one-plan-per-group-and-add-ons-stack.md), [0041](./0041-a-custom-plan-is-a-catalog-opt-in.md), [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md)
- **Amends:** [0041](./0041-a-custom-plan-is-a-catalog-opt-in.md) §5, consequences, "what would reopen"; [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) "what would reopen"

## Context

[ADR 0041](./0041-a-custom-plan-is-a-catalog-opt-in.md) §5 refused `custom: true` with
`isDefault: true` (`CatalogCustomDefaultPlan`). The reason was a definition: `isDefault` is the plan a
group's cancellation falls back to ([ADR 0039](./0039-one-plan-per-group-and-add-ons-stack.md) §5), a
fallback is the catalogue's terms, and a bespoke set is not a fallback anyone quoted.
[ADR 0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) accepted the custom add-on
and kept the refusal, with that sentence as the whole argument.

The sentence is too strong. A cancellation never re-grants a bespoke set, even today:

- `defaultPlanFor` resolves the group's `isDefault` plan through
  `planTermsOf(catalog, tier.id, currency)`, so the fallback row carries the catalog's `grants`,
  price, credits, expiry and rates — exactly what every customer under that plan gets.
- `CancelGroup` freezes that row on `GroupCancellationScheduled.fallback` when the cancellation is
  scheduled, and the boundary applies the frozen row from the log. Nothing in `decide` reads the
  bespoke terms the customer held.

So the refusal protected a rule the implementation already enforces. It also left a hole in the
same shape it was trying to close: once ADR 0042 accepted a custom add-on, a plan could state
`custom: true`, `addOn: true` and `isDefault: true` and the catalog accepted all three. An add-on
fills no group, so it could never be a cancellation's operand; `defaultPlanFor` merely happened to
find no base plan and returned nothing. The combination was accepted by accident and meant nothing.

## Decision

**1. A custom plan may be a group's `isDefault`.** `CatalogCustomDefaultPlan` disappears from the
catalog error union, from `defineCatalog`, and from the public exports. The catalog's opt-in does not
change: a fixed plan is still fixed, a pack is still refused (`CatalogCustomPack`), and a custom
add-on is still allowed.

**2. A cancellation re-grants the catalogue's terms, never a bespoke set.** The fallback row is
resolved by `defaultPlanFor` from `planTermsOf(catalog, tier.id, currency)`, so it already carries the
catalog's grant set rather than the terms the customer was sold. The frozen `fallback` row on
`GroupCancellationScheduled` is the deal the boundary records. Nothing in `decide` changes, and no
event gains a field. This is the rule that replaces the refusal: a bespoke set belongs to the plan a
customer held; the fallback is what the catalog quotes to everyone.

**3. An add-on cannot be a group's default.** The catalog refuses `addOn: true` with
`isDefault: true` as `CatalogDefaultOnAddOn({ tier })`, and `defaultPlanFor` ignores a candidate whose
`addOn` is `true`. An add-on stacks beside every group and fills no slot, so a default add-on would
be a fallback slot that never fills. The refusal states the shape instead of leaving it to an
accidental no-op.

**4. A variant inherits `custom`, and does not inherit `isDefault`.** `mergeVariant` already carried
the base's `custom` into its variants; it now drops the base's `isDefault`, because `isDefault` is
stated per plan. A variant of a custom default plan is legal, is custom, and is not a second fallback
for the group. A variant that states its own `isDefault` keeps it.

**5. The models do not change.** `specs/paykit/*.qnt` models the plan set and its fallback slot, not
the terms a plan row carries: `schedules.qnt` already has a group, a base plan, an add-on and a
cancellation that resolves to the group's default. Which grants that default holds is data the model
does not own, exactly as ADR 0041 §9 and ADR 0042 §4 record for their slices. No action, invariant,
mutant or command-coverage row is added; `pnpm spec` and `pnpm spec:coverage` are gates on not having
broken one.

**6. The tests name the rule.** `test/Catalog.test.ts` accepts a custom default plan and refuses an
add-on default with `CatalogDefaultOnAddOn`; `test/catalog/Guard.test.ts` proves a bespoke set still
validates structurally against a custom default plan; `test/billing/CustomPlans.test.ts` cancels a
group whose `isDefault` is custom and proves the fallback row carries the catalog's terms, not the
bespoke set the customer held, both on the scheduled cancellation and at the boundary.

## Consequences

- `CatalogCustomDefaultPlan` is gone; `CatalogDefaultOnAddOn` replaces it in the catalog error union
  and the public exports.
- `defaultPlanFor` skips add-ons and keeps resolving the fallback from `planTermsOf`, so a custom
  fallback is the catalog's quote by construction rather than by a second rule.
- `mergeVariant` no longer inherits `isDefault`. A variant that wants the fallback states it.
- `docs/briefs/custom-plans.md`, `NEXT.md` and `BILLING-SURFACE.md` move the fallback from missing to
  shipped, leaving the per-plan balance source as the custom-plan follow-up.

## Alternatives considered

- **Keep the refusal and tell a deployment to use a fixed fallback.** Rejected: it forbids a shape
  that is already safe. A group whose fallback is the same negotiated plan everyone starts on is a
  real arrangement, and refusing it would push the fallback into a second plan that differs only in
  name.
- **Re-grant the bespoke set the customer held.** Rejected: the fallback is not a continuation of one
  customer's deal; it is the plan the catalog offers when a group ends. Recording a bespoke set there
  would freeze a negotiation as the deployment's floor.
- **Let an add-on default be ignored silently.** Rejected: an accepted combination that cannot
  happen is a trap for the next reader. The catalog's job is to refuse a shape it cannot honour.
- **A per-customer fallback.** Rejected for this slice: that is a negotiated cancellation policy, not
  catalog data, and it would need its own record and approval path.
- **Resolve the fallback at the boundary from the catalog instead of freezing it.** Rejected: the
  boundary must replay without a catalog ([ADR 0039](./0039-one-plan-per-group-and-add-ons-stack.md)
  §3, §5), and a catalog deploy between scheduling and cancelling must not change what was agreed.

## What would reopen this

- **A negotiated fallback.** A cancellation policy that re-grants terms other than the catalog's
  default needs a record of its own, the way a negotiated price needed the operation's `price`
  ([ADR 0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) §3).
- **The per-plan balance source.** A fallback that is a custom add-on's base still merges one
  feature into one count; the read-model follow-up named in ADR 0042 §2 is what would make a stacked
  fallback report its own breakdown row.
- **An explicit default-per-group rule.** Today the first `isDefault` plan in catalog order wins. A
  catalog that states two defaults in one group is indistinguishable from a mistake, and a refusal
  would be the next gate if deployments start declaring variants as fallbacks.
