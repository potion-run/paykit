# What to build next

A handoff for whoever (or whatever) picks this up cold. The state, the queue, the traps, and how the
last few slices were done. Nothing here overrides the ADRs in [`docs/adr/`](./adr/); where they
disagree, the ADR wins and this file is wrong.

## Where it stands

`@potion.run/paykit` is at `0.1.0`, unpublished and never deployed. Three packages publish together
(`paykit`, `paykit-polar`, `paykit-stripe`) on one version line. The gates are green: `format:check`,
`lint`, `typecheck`, `test` (every project; the vendor live cases skip without a key), `build`,
`exports:check`, `validate:publish-packages`.

What the catalog can express today: units with `block | bill | allow`, `"unlimited"`, `kind: "flag"`
grants, `carryOver`, credits with a per-dimension rate card (`creditRates`), a spend cap (`cap`), a
postpaid `unitPrice` with a `moneyCap`, and a `kind: "one_off"` credit pack. What the runtime can do: `check` from local state, `track`,
`hold`/`settle`/`release` as addressable entities, a policy that releases a hold on its own deadline,
proration, dunning, trials, credits, bought packs whose credits survive a period close and are
spendable before a plan exists, postpaid usage priced per unit with a money cap, an outbound edge
that signs and retries every committed event, and a provider-port edge with webhook decoders for
Stripe and Polar. What the deploy does: validates the catalog into `BillingStack`, and `StripePrices` /
`PolarPrices` create the base prices and products its tiers are sold under, plus a meter and a
metered price for every postpaid feature. What the close does: `PeriodCloseUsage` sends the closing
period's billable units to the account's provider once, with the period as the idempotency key.

The six records behind that: [0001](./adr/0001-catalog-states-the-pricing-model.md) (pricing is
catalog data, the deploy provisions the vendor), [0002](./adr/0002-credits-are-the-unit-of-account.md)
(credits are a unit of account, one pool per account), [0003](./adr/0003-the-deploy-provisions-the-vendor.md)
(identity in the vendor's own field, replace on change, never delete), [0004](./adr/0004-a-hold-is-one-call-and-an-id.md)
(a hold is an entity, one call settles it), [0005](./adr/0005-a-spend-cap-is-a-ceiling-in-units.md)
(a cap is a count, not money), [0006](./adr/0006-postpaid-usage-is-a-unit-price-in-the-catalog.md)
(postpaid usage is a unit price in the catalog, and a money cap is a separate ceiling), and
[0007](./adr/0007-outbound-events-are-a-policy-over-a-port.md) (outbound events are a policy over a
delivery port; paykit signs and keys, the app sends).

## The queue

Ordered by value per unit of work. Each is small enough to finish in one pass and leave green.

The vendor meter landed in [ADR 0006](./adr/0006-postpaid-usage-is-a-unit-price-in-the-catalog.md) §2:
the quantity pushed at close is the period's *billable* units (`used - included`), not `billed`
money, because the vendor applies its own metered price. `decide` still never reads the provider;
the push is a policy after the close. A mid-period price change is split per vendor price now
([ADR 0008](./adr/0008-a-report-names-the-price-each-unit-was-recorded-at.md)): `UsageRecorded` carries
the price and its billable units, and the report carries one line per price.

What is left of that item is the rule that makes the split observable. `ChangeTier` refuses to move
below what the account already used, and it refuses that for a billed allowance as well as a
blocking one — but `used > included` is what "billed" means, so in practice a price change is only
possible while the period has billed nothing yet. Relaxing `DowngradeBelowUsage` for a billed
allowance, and deciding what proration goes with it, is the next slice; the report no longer has to
change for it.

### 1. The remaining surfaces

- **Console screens**: balances, usage timeline, "why is this account on pro" (`Preview` answers it),
  open holds with their age, manual grant, refund.
- **Archived prices** (ADR 0003): a retired Stripe price is retained but stays `active: true`, and a
  retired Polar product stays purchasable. Archiving needs a vendor write against a resource the
  stack no longer tracks — a sweep by lookup-key (Stripe) or name prefix (Polar) is the obvious
  shape.

## The live cases that have never been run

Both provisioning packages carry a live test that is gated on a vendor key and reports **skipped** in
every run so far. They are the only proof each helper works against a real API, and the only place
the "replace keeps the old one" claim is actually tested.

```sh
STRIPE_API_KEY=sk_test_… pnpm --filter @potion.run/paykit-stripe test
POLAR_ACCESS_TOKEN=polar_sandbox_… pnpm --filter @potion.run/paykit-polar test
```

Run them before trusting provisioning, and before publishing anything that advertises it. Expect
them to create and retire prices/products in those test accounts; both start with `stack.destroy()`
and leave retained objects behind, which is the point of the rule and a mess in a shared account.
The Polar case is pinned to `server: "sandbox"`, so a production token cannot reach production.

## How the last slices were done

Each landed as an ADR first, then a brief, then an implementation in a separate agent pane, then an
independent review by the person who wrote the brief — which caught three real bugs the delegate's own
summary did not: a lookup key that collided across stages, a `RemovalPolicy.retain` that was claimed
but not wired, and a credit release that returned units where it owed credits.

The briefs are the useful artefact: they name the files to read, the exact API to produce, the tagged
refusals, the tests required, the gates, and the instruction to stop at a green step-1 rather than
finish red. Two live in `/tmp` from this session and are worth copying into `docs/briefs/` if this
continues.

## Invariants not to break

- **`decide` is pure.** No clock, no provider, no ambient read; anything it needs travels in the
  command, then the event, then the state.
- **One standing per account, one credit pool per account.** Credits are not per feature.
- **Events carry the money.** `UsageRecorded.cost` and `.charge`/`.billedAfter`,
  `Pricing`/`TierChanged` prices, the captured hold rate — a replay must reproduce every number, and
  a catalog change must never reprice history.
- **A cap is a ceiling, not a standing.** `allowed: false` at a quantity or money ceiling while
  `standing` stays `good`.
- **A deadline is a command, not a timer.** A policy schedules a command that never rejects, and
  `decide` reads the clock from its context: past the deadline it acts, before it or after the entity
  closed it records nothing. That is how `PeriodEnded`, `GraceElapsed` and `HoldElapsed` stay
  replayable.
- **A pack outlives the period.** Credits a one-off pack bought never expire, even on a plan whose
  own credits do: `prepaidCredits` is protected, spent only after the plan's credits, and a close
  returns only the difference.
- **A missing capability is a tag.** `ProviderCapabilityMissing`, never a silent no-op.
- **Nothing is deleted that a bill references.** Prices and products are retained; the event log is
  the record.
