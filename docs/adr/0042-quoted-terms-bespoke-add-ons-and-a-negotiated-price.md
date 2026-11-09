# 0042 — Quoted terms, bespoke add-ons and a negotiated price

- **Status:** Accepted
- **Date:** 2026-11-12
- **Follows:** [0035](./0035-plans-plan-items-and-balance-sources.md), [0039](./0039-one-plan-per-group-and-add-ons-stack.md), [0041](./0041-a-custom-plan-is-a-catalog-opt-in.md)
- **Amends:** [0041](./0041-a-custom-plan-is-a-catalog-opt-in.md) §3 (price), §5 (add-ons), §7 (checkout)

## Context

[ADR 0041](./0041-a-custom-plan-is-a-catalog-opt-in.md) made a bespoke allowance set a catalog opt-in
and recorded three gaps rather than papering over them:

- a priced custom plan's first activation cannot cross a hosted checkout, because the provider's
  event names the plan and not the negotiated allowances;
- a custom add-on is refused until the balance read model can report one source per plan;
- a negotiated price is not a custom plan field, because a plan's price is the catalog's.

The first two are now the only things standing between a deployment and a deal it can actually
sell through the surface `Attach` advertises. The third is the sentence a sales conversation ends
on. This ADR decides all three, in the order they block a quote.

## Decision

**1. A hosted purchase carries its quote as a pending activation.**
`AttachProviderRef` and `ProviderRefAttached` gain an optional `pending: PendingActivation`; the
aggregate stores it beside `refs` on both `Unsubscribed` and `Subscribed`, and an activation drops
it. A pending activation is the `Subscribe` input plus the period anchor: `tier`, `group`, `addOn`,
`allowances`, `price`, `credits`, `creditsExpire`, `topUp`, `rates` and `anchorTz`. It is written
before the provider is asked and read by the webhook that completes the purchase.

The completion prefers the quote whenever one exists, so a catalog deploy between checkout and
webhook cannot replace the terms that were sold. A fixed plan with no quote still falls back to the
catalog, which is what an out-of-band provider subscription is. A custom plan with no quote is
`PendingActivationMissing`: its catalog defaults are a different deal at the same price, so the edge
refuses rather than records them. A quote that names another plan is `PendingActivationStale`. Both
are edge refusals (`Webhook.binding`) and answer `400`; retrying a missing quote would find the same
nothing.

A newer checkout overwrites the quote. The latest purchase is the one a completion can be about,
and a provider event that names another plan is refused rather than activated against the wrong
terms. `PlanOperationUnsupported({ reason: "custom_plan_checkout" })` is removed: the operation it
described now has a path.

**2. A custom add-on is an `addOn` plan with a bespoke set.**
`custom: true` beside `addOn: true` is accepted. `CatalogCustomAddOn` is removed. The guard's custom
branch already judges the set structurally, and an add-on is a plan: the same rule accepts its
items, the same attach path stacks it beside every group, and the same event carries the terms. A
custom add-on is base-independent — it is invoked through `Attach`, `Subscribe`, `ChangeTier` or
`ScheduleTierChange` exactly like a catalog add-on.

The merge remains the interim single-source rule: two plans that grant one feature merge into one
count. The per-plan balance source is landing separately. Until it does, `Balance.breakdown` reports
the merged plan source, not one row per add-on; that is a read-model follow-up, not a guard or attach
gap. A feature two plans grant with different spend shapes is likewise the merge rule's follow-up.
`custom` with `isDefault: true` stays refused (`CatalogCustomDefaultPlan`): a fallback is the
catalogue's terms.

**3. A negotiated price is a price on the custom plan operation, not catalog data.**
`custom: true` is the deployment's opt-in, so the same opt-in permits the operation to state a
`price`. The catalog's price stays the plan's default and the quote a caller gets when it states
none. `AttachRequest`, `PreviewAttachRequest`, `SubscribeRequest`, `ChangeTierRequest`,
`ScheduleTierChangeRequest` and `PreviewCommand` each gain an optional `price`; the low-level
commands already carry one. `withGrants` applies it to the same join, and `planChangeTier` computes
proration to it.

For a custom plan the guard accepts the catalog's price or the stated override; for every other
plan, and for a custom plan that states no price, the exact rule is unchanged. The override is
explicit because it is the operation's `price`, not a field smuggled into the catalog, and it is
guarded by the same plan opt-in as a bespoke allowance set. The event carries the deal with no new
field: `SubscriptionActivated.price`, `PlanChanged.priceAfter` and `PlanChangeScheduled.price`.
`CurrencyMismatch` still applies against a live standing.

A hosted checkout sells the vendor's price object, which is the catalog's price; it cannot sell an
amount. A first activation whose stated price differs from the catalog's therefore takes the
invoice path, which takes the amount, and keeps the quote on the reference like any other purchase.
A provider that declares checkout but not invoice is `ProviderCapabilityMissing` for that deal
rather than being asked to charge a price it does not have.

A `price` that differs on the same custom plan is a renegotiation, not a replay: `Attach` and
`PreviewAttach` compare the price in force and take the ordinary move path (immediate when it is an
increase, the boundary by default otherwise). Omitting `price` keeps the catalog default; a caller
that wants to return a negotiated plan to the catalogue states the catalog's price explicitly.

**4. No decision and no model change.**
`decide` still reads only the command and the state; it never reads the catalog. The pending
activation is a field of the state the command path already carries, and the price and allowances
are the fields the commands already had. `specs/paykit/*.qnt` has never modelled provider references
or price negotiation, so no action, invariant, mutant or coverage row is added.

## Consequences

- `PendingActivation`, `PendingActivationMissing` and `PendingActivationStale` are new exports.
  `ProviderRefAttached` gains `pending?`; `SubscriptionState` holds it on both variants;
  `standingFrom` drops it because it constructs a fresh standing from the event.
- `CatalogCustomAddOn` disappears from the catalog error union. The catalog accepts a custom
  add-on, and `test/Catalog.test.ts` proves it.
- `AttachRequest`, `PreviewAttachRequest`, `SubscribeRequest`, `ChangeTierRequest`,
  `ScheduleTierChangeRequest` and `PreviewCommand` gain `price?`.
- `withGrants` gains an optional `price`; `planChangeTier` gains the same optional price so the
  proration and the command agree.
- A negotiated amount is invoiced rather than checked out, because the checkout port has no amount.
- The webhook path reads the stored quote before falling back to the catalog, and clears the quote
  by activating.
- `BILLING-SURFACE.md` and `NEXT.md` move the three gaps to shipped, with the per-plan balance
  source named as the remaining read-model follow-up.

## Alternatives considered

- **Rebuilding the activation from the catalog and refusing a bespoke checkout (ADR 0041 §7).**
  Rejected now that the quote can ride the reference: refusing would keep the advertised `Attach`
  from selling the deal it accepts.
- **A provider metadata field for every allowance.** Rejected: it puts the model's terms in the
  vendor's payload, where a deploy cannot read them back without a second catalog join, and a
  provider that limits metadata size becomes a limit on the deal.
- **A pending activation as a separate stream aggregate.** Rejected: it belongs to the account the
  purchase is for, and it must be read in the same state that decides the activation. A second
  aggregate would need a second ordering and a second replay.
- **Refusing a custom completion with no quote only for a bespoke set.** Rejected: a custom plan's
  defaults are still a deal, and the edge cannot tell whether the checkout was opened with them or
  with a quote that was lost. Uniform refusal is the honest answer.
- **A separate `attachAtPrice` command.** Rejected: it would duplicate every plan move and need its
  own event, while the command and the event already carry `price`.
- **A per-customer price in the catalog.** Rejected: that is the customer table ADR 0041 refused,
  one deploy per negotiation.
- **Waiting for the per-plan balance source before allowing a bespoke add-on.** Rejected: the guard
  and the attach path do not depend on the breakdown. The breakdown is a read answer, and the
  merged answer is already correct for what can be spent; it names the follow-up instead of
  blocking the sale.

## What would reopen this

- **The per-plan balance source.** `Balance.breakdown` should report one source per plan, and the
  merge should refuse two different spend shapes for one feature rather than letting the first plan
  state the rules silently.
- **A quote that must survive several concurrent checkouts.** The current record is one quote per
  account, so the latest purchase wins and an older one is stale. A record keyed by the provider
  reference would need the reference on the webhook event.
- **A negotiated price as a versioned resource.** Today the price is history as soon as the event
  is written; a price that must be re-quoted or approved is a deployment workflow with its own
  record.
- **A custom plan as a group's fallback.** Still needs a rule for what a cancellation re-grants
  when the fallback's allowances were never catalog data.
