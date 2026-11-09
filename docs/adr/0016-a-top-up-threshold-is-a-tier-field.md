# 0016 — A top-up threshold is a field on the tier

- **Status:** Accepted
- **Date:** 2026-11-06
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md)

## Context

[ADR 0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) made auto top-up a deployment
policy with one threshold and one pack. The threshold is the number that decides when a spend is a
crossing; the pack is the product bought on that crossing. One number cannot describe every tier:

- A free tier that grants 1,000 credits runs out at 1,000. A threshold of 5,000 is above its whole
  pool, so every spend from a fresh grant is a crossing.
- An enterprise tier that grants 1,000,000 credits reaches 5,000 only after it has spent almost
  everything. A threshold of 5,000 is a refill after the incident, not before it.

The bucket a pack fills is still one pool per account, and the product is still one pack per
deployment. What changes between tiers is only the line at which spending into that pool should buy
the next pack. [ADR 0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) named this as the
next decision and left the field out on purpose.

## Decision

**1. `Tier.topUp` is the threshold, in credits.** It is catalog data, an optional non-negative
integer on a subscription tier:

```ts
const pro = Paykit.plan({
  id: "pro",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  credits: 50_000,
  topUp: 5_000,
  grants: [Paykit.planItem(messages, { included: 2_000, overage: "bill" })],
});
```

A tier without `topUp` never refills. A one-off pack cannot declare one: it has no standing, so
there is no spend in it for a threshold to observe. The catalog refuses that shape with
`CatalogTopUpOnPack`, because a field nothing reads is worse than a refusal an author can see.

**2. The threshold travels on the standing, from the catalog through the command.** `Subscribe`,
`StartTrial`, `ChangeTier` and `ScheduleTierChange` carry it; `SubscriptionActivated`,
`TrialStarted`, `PlanChanged` and `PlanChangeScheduled` record it; `evolve` copies it. This is the
same route `credits`, `creditsExpire` and `rates` already take, and for the same reason: `decide`
is pure and the policy runs without the catalog. A change to a tier without `topUp` clears the
field rather than keeping the previous tier's line.

**3. The deployment still names the pack, and only the pack.** `Paykit.autoTopUp({ catalog, pack })`
resolves the pack's credits, price and rates once and provides the policy. The threshold comes from
the standing, so it is not an option on the layer:

```ts
Paykit.autoTopUp({ catalog, pack: credits.id });
```

The layer's `AutoTopUpInvalid` still refuses an unknown pack, a subscription tier, a pack with no
credits or no price. The threshold is no longer a layer refusal because the catalog schema refuses
a negative one and `CatalogTopUpOnPack` refuses the shape that could not fire.

**4. The crossing rule is unchanged.** The policy still buys when a spend takes the pool from above
the standing's threshold to at or below it, keyed by the crossing, with the pack as the cooldown.
A tier change moves the line for the next spend; it does not buy retroactively. A scheduled change
applies at the close, so the next period starts on the new tier's threshold.

**5. `BillingState` carries the threshold.** "On pro, refilling below 5,000 credits" is one sentence
an operator needs, and the read model already carries the rest of the tier's terms. The field is the
standing's, not the catalog's, so a scheduled change shows the pending tier's threshold without a
second lookup.

## What this does not decide

- **A per-tier pack.** The pack is still one product for the deployment. A tier that needs a
  different pack is a later field with its own validation, not a second config today.
- **A time cooldown.** The pack is still the cooldown. A deployment that wants a hard spend-rate
  bound needs a scheduled command and its own timer, as [ADR
  0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) says.
- **An off-session charge.** The policy still opens the provider invoice and records the purchase.
  A saved-card charge is a provider capability, not a threshold.

## Consequences

- **The layer's API loses `threshold`.** A deployment that used the global line moves it onto the
  tiers it wants refilled. Synthetic errors for a bad threshold disappear with the option; the
  catalog is where a bad line is now refused.
- **An account with no standing has no tier to read a line from.** A pool that holds only a pack
  bought before any plan existed does not auto top-up; the deployment-wide number used to cover
  that case. A prepaid-only deployment that needs it is a later decision — a line on the no-plan
  state or on the pack — not a hidden fallback under the tier field.
- **The threshold is part of the tier's command contract.** `CatalogGuard` compares it like the
  credits and the rates, so a caller cannot move the line without a catalog change. The stack does
  not bump its version: the field is optional on every event and state that carries it, and an old
  record decodes with no threshold.
- **A free tier is now a first-class refill candidate.** It grants a small pool and states a line
  below that pool, which is exactly the case the deployment-wide number could not express.

## Alternatives considered

- **Keep the deployment threshold as a fallback for tiers without `topUp`.** Two sources for one
  line, and a deployment that sets both has to know which tier wins. The catalog is the answer to
  "when should this tier refill", so a tier without the field means no refill.
- **Put the threshold on the pack.** The pack is what is bought; the threshold is when. Putting it
  on the pack would make every tier that buys the same pack share a line, which is the problem this
  slice exists to solve.
- **Resolve the threshold in the policy from the catalog by tier id.** The policy already has the
  catalog, but the standing is the thing a replay and a scheduled change agree on. Reading the
  catalog would let a catalog edit change the line under a standing that was sold a different one,
  the same reason prices and allowances travel on events.
- **A second `AutoTopUpConfig` per tier.** It would be a deployment map keyed by tier id, with no
  validation against the catalog, no guard on the command, and no row for a tier the deploy added
  later. The tier is already the place a plan's terms live.

## What would reopen this

- A prepaid-only deployment that needs a line with no standing: a threshold on the no-plan state,
  or on the pack, with the same guard and event rules as the tier field.
- A deployment that needs a different pack per tier: a `Tier.topUp.pack` field and the matching
  catalog validation.
- A deployment that wants a hard spend-rate bound: a `cooldown` command with a deadline, as
  [ADR 0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) says.
- A provider that can charge a saved method: an optional `charge` capability on the port.
