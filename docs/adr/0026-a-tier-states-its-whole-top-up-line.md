# 0026 — A tier states its whole top-up line

- **Status:** Accepted
- **Date:** 2026-11-07
- **Follows:** [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md), [0016](./0016-a-top-up-threshold-is-a-tier-field.md), [0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md)

## Context

[ADR 0016](./0016-a-top-up-threshold-is-a-tier-field.md) put the threshold on the tier and left the
other two halves of the same sentence on the deployment. That split does not survive contact with a
real catalog:

- **The pack.** A free tier that runs out of a 1,000-credit pool wants a small pack; an enterprise
  tier that runs out of a million-credit pool wants a large one. [ADR
  0016](./0016-a-top-up-threshold-is-a-tier-field.md) moved the *when* to the tier for exactly this
  reason and left the *what* — the product bought — as one product for the whole deployment. So a
  deployment with two tiers now refills both with whichever pack the deploy named, and the enterprise
  account's crossing buys a 1,000-credit pack.
- **The cooldown.** [ADR 0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md) made the
  cooldown a deployment option and recorded it on the standing. A hard spend-rate bound is a property
  of what a tier is worth: one pack an hour is generous on a free tier and mean on an enterprise one.
  A deployment-wide duration cannot be both.

[ADR 0016](./0016-a-top-up-threshold-is-a-tier-field.md)'s "What would reopen this" names both — "a
deployment that needs a different pack per tier: a `Tier.topUp.pack` field and the matching catalog
validation" — and this is that slice.

## Decision

**1. `Tier.topUp` is the whole line: the threshold, how often it may refill, and which pack it
buys.** One field, one shape, because a threshold and the terms it spends are one sentence and
splitting them is what produced the mismatch above.

```ts
export const TopUpTerms = Schema.Struct({
  /** Credits at or below which a spend is a crossing. */
  threshold: TopUpThreshold,
  /** The shortest time between two purchases on this tier. */
  cooldown: Schema.optionalKey(Schema.Duration),
  /** The `kind: "one_off"` pack this tier buys. */
  pack: Schema.optionalKey(TierId),
});
```

The author-facing input is the same shape, and `tier()` copies it:

```ts
const pro = Paykit.tier({
  id: "pro",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  credits: 50_000,
  topUp: { threshold: 5_000, cooldown: Duration.hours(1), pack: "credits_100k" },
  grants: [Paykit.allowance(messages, { included: 2_000, overage: "bill" })],
});
```

There is no `number` form beside the struct. The field already sits beside `credits` on a tier that
states six other terms, and a union here would make two spellings of the line for the same reason
[ADR 0015](./0015-a-runtime-binding-names-a-command.md) refused a second spelling of a binding.

**2. The cooldown is a `Duration` in the catalog and a deadline on the standing.** The catalog is
deployment config that has to serialize, so the field is `Schema.Duration` and not a vendor string.
Nothing new is recorded on the standing: [ADR
0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md) already carries `topUpCooldownUntil`
on the purchase and `topUp` on every activation, change and schedule event. The deadline a crossing
opens is measured with *that tier's* cooldown instead of the deployment's:

```
cooldownUntil = envelope.at + (standing.topUp.cooldown ?? deployment cooldown)
```

**3. The pack is resolved from the catalog at layer build, per tier, and validated.** The catalog
refuses a tier whose `topUp.pack` names a tier that is not a `kind: "one_off"` pack with credits and a
price, with the same tag the layer used before — `CatalogTopUpOnPack` stays the pack-cannot-state-a-line
refusal and `CatalogUnknownTopUpPack` is the new one for a name the catalog does not sell.

`Paykit.autoTopUp({ catalog, pack, cooldown? })` keeps its options and resolves them into a table: the
named default pack, plus every pack a tier names, each resolved once to its credits, price and rates.
A standing's pack is `standing.topUp.pack ?? the default the deploy named`, so a deployment that
states one pack for every tier writes what it writes today, and a tier that names its own buys that
one.

The default stays on the layer rather than becoming required catalog data because a deployment with
one pack should not have to repeat its id on every tier — the same argument [ADR
0016](./0016-a-top-up-threshold-is-a-tier-field.md) used for the threshold, in the other direction: the
*when* is per tier because it differs, the *what* defaults because it usually does not.

**4. The tier's cooldown wins over the deployment's; a tier that states none inherits the
deployment's.** This is the one asymmetry, and it is the useful one: `Paykit.autoTopUp({ cooldown })`
is the deployment's spend-rate floor, and a tier that wants a different bound states it. Absent on
both, a second crossing buys a second pack, exactly as [ADR
0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) decided.

**5. A variant replaces the whole line, not part of it.** `customize.topUp` states the variant's
`{ threshold, cooldown, pack }` outright, exactly as `customize.price` replaces a price wholesale: a
variant that changes the threshold and keeps the base's pack would be a tier whose line is assembled
from two places, and the guard compares the whole line as one key. A variant that wants the base's
line states nothing.

**6. `BillingState` carries the line.** It already carries `topUp` and the deadline; with the field
now a struct, a page can say "on pro, refilling below 5,000 credits from the 100k pack, at most hourly"
without a second lookup.

## What this does not decide

- **A pack for an account with no standing.** [ADR
  0016](./0016-a-top-up-threshold-is-a-tier-field.md) already refused the hidden fallback and this
  keeps that: no standing, no line, no refill. A prepaid-only deployment needs its own decision.
- **A per-tier cap on how many packs one period may buy.** The cooldown bounds *how often*, not *how
  many*; a period budget is a different number with a different refusal.
- **`TopUpFailed`.** A decline that the deployment must remember is its own event and its own ADR.

## Consequences

- **The catalog shape changes under `topUp`, and every record that carries it.** This package is
  `0.1.0`, unpublished and never deployed, so there is no older record to keep decoding; the field is
  replaced rather than unioned. The commands, the events, the state, the view and the guard carry the
  same struct they carried before, one field wider.
- **`TopUpThreshold` stays the number and is no longer the field.** It keeps its name as the
  non-negative integer, so the brand and the check are unchanged; `TopUpTerms` is the new field type
  and is what the package exports for a page or a test to build.
- **A tier's pack is catalog data the deploy already sells.** `StripePrices` and `PolarPrices` create
  a price for every one-off tier whether or not a line names it, so naming one costs no new
  provisioning.
- **A cooldown mismatch is now impossible.** The deadline is derived from the standing the spend
  happened against, so a scheduled tier change changes the bound at the boundary along with the line
  and the pack.

## Alternatives considered

- **A deployment map keyed by tier id.** `Paykit.autoTopUp({ packs: { free: "small", pro: "large" } })`
  is the shape [ADR 0016](./0016-a-top-up-threshold-is-a-tier-field.md) already rejected for the
  threshold: a map validates against nothing, has no row for a tier the deploy added later, and
  duplicates the catalog in a second place.
- **`topUp: number | TopUpTerms`.** Keeps every existing config compiling and costs a union in the
  schema, the guard, the view and the event. Since nothing is deployed, the compatibility buys nothing
  and the union would be permanent.
- **Resolve the pack in the policy from the catalog by tier id.** Same argument [ADR
  0016](./0016-a-top-up-threshold-is-a-tier-field.md) made for the threshold: the standing is what a
  replay and a scheduled change agree on, and reading the catalog would let an edit change the product
  a crossing buys under a standing that was sold a different one.
- **Resolve the line at layer build for every tier.** It would make the policy's table the catalog's
  table, and refuse a deployment whose catalog has a pack no tier names. The catalog is already the
  validator; the layer resolves only what it may buy.

## What would reopen this

- A period budget per tier: a `Tier.topUp.limit` with a per-period count on the standing and its own
  refusal.
- A pack with no tier to hang the line on (a prepaid-only deployment): a line on the no-plan state.
- A cooldown that must be shorter than one crossing's deadline but not zero: an explicit
  `Duration.zero` already means "no cooldown", so a floor below the clock's resolution is a different
  field.
