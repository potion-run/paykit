# What to build next

A handoff for whoever (or whatever) picks this up cold. The state, the queue, the traps, and how the
last few slices were done. Nothing here overrides the ADRs in [`docs/adr/`](./adr/); where they
disagree, the ADR wins and this file is wrong.

## Where it stands

`@potion.run/paykit` is at `0.1.0`, unpublished and never deployed. Four packages publish together
(`paykit`, `paykit-polar`, `paykit-stripe`, `paykit-admin`) on one version line. The gates are green:
`format:check`, `lint`, `typecheck`, `test` (every project; the vendor live cases skip without a
key), `build`, `exports:check`, `validate:publish-packages`.

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

The rule that made the split observable landed too
([ADR 0009](./adr/0009-only-a-blocking-allowance-refuses-a-move-below-its-usage.md)): only a blocking
allowance refuses a move below its usage, because only a blocking one can be oversubscribed. A billed
or allowed feature may change its unit price mid-period, and the close reports the units at both
prices. The money ceiling closed too ([ADR
0011](./adr/0011-a-tier-change-cannot-move-into-a-ceiling-already-passed.md)): a change into a cap the
period has already billed past is refused with `DowngradeBelowSpend`, and a change into a unit ceiling
it has already passed with `DowngradeBelowCeiling`. Both were previously reachable, and both produced a
standing no command could leave until the period reset.

### 1. The remaining surfaces

- **Scheduled tier changes**: done
  ([ADR 0012](./adr/0012-a-tier-change-can-be-scheduled-for-the-boundary.md)). The standing carries
  `pendingTier`, the close applies it before the reset, and `WithdrawTierChange` takes it back.
  `actionsFor` offers the schedule for tiers `ChangeTier` refuses and the withdrawal only while one is
  pending; `Preview` decides both; `BillingState` carries `pendingTier` so a page can say "on pro,
  moving to small at the period end"; the console sends both. What is left is a `ChangeTier`-style
  quote screen for scheduling — the command needs none (a scheduled change carries no proration), so
  the console builds it from the catalog it already holds.
- **Console screens**: `paykit-admin` now shows balances, the period's priced usage, "why is this
  account on X" (`Preview`), open holds with their deadlines, verification against the deploy and a
  manual grant. The one left is **refund**, and it is not a screen: paykit has no refund command, so
  it needs a decision record — which event, which money, which provider call — first.
- **Archived prices** ([ADR 0010](./adr/0010-a-price-that-leaves-the-catalog-is-archived-not-deleted.md)):
  a retired Stripe price is retained but stays `active: true`, and a retired Polar product stays
  purchasable. Both halves landed for Stripe — `retiredPrices` decides, `RetiredPrices` lists and
  deactivates, and the live case proves a price is archived rather than deleted. What is left is the
  Polar half, which waits on its sandbox token.

### 2. Worth building next

Three things the model is one step away from, and why they belong in a library rather than in a
hosted service. A console is not one of them: what a library owes is the read model a console renders,
and `Preview`, `List`, `BillingRead` and `AccountEvents` are that. The screens themselves are the
example's job.

- **Auto top-up.** When a pool falls below a threshold, buy a pack — a policy over `CreditsConsumed`
  sending `PurchaseCredits`, the same shape `Dunning` and `PeriodRollover` already have. The decisions
  are the threshold, the pack, a cooldown, and one command per crossing rather than one per event. It
  turns "the hold failed" into "the account refilled", which is the difference between billing users
  notice and billing they do not.
- **A usage timeline projection.** Not a log database: `AccountEvents` is already the log, so a
  timeline is a projection over it — per feature, per period, with the holds opened and settled and the
  money each recorded. It is the screen people open when a bill looks wrong, and it is the half of
  `Preview` that answers "what changed" rather than "why".
- **Per-customer custom plans.** A `TierChanged` already carries the allowances it granted, so history
  stays exact; what refuses a bespoke deal today is `CatalogGuard`, which will not accept a standing
  whose allowances are not in the catalog. Making that an explicit opt-in (or a declared `custom` tier)
  is a decision, not code, and it is the one thing here a host cannot do for itself.

## The live cases

Both provisioning packages carry a live test that is gated on a vendor key and reports **skipped** in
every other run. They are the only proof each helper works against a real API, and the only place
the "replace keeps the old one" claim is actually tested.

**Stripe ran green on 2026-11-05**, from `main`, on a test-mode account — [run
41971381878](https://github.com/potion-run/paykit/actions/runs/41971381878), 48 passed and none
skipped. So the price the catalog states is created, replaced on a change, and the replaced one is
retained and still retrievable; the meter and the metered price are created from the same unit price.
**Polar has not run.** It waits on `POLAR_ACCESS_TOKEN`, and its guard fails rather than skips until
the secret exists.

They run from `.github/workflows/live.yml` — a manual dispatch, from `main`, with a `vendor` input of
`both`, `stripe` or `polar`. It is separate from `check.yml` for two reasons: the cases mutate a real
test account, and a secret must not be in the path of a pull request from a fork. A missing secret
**fails** that workflow rather than skipping it, because a manual run whose only purpose is the live
case should not report green having done nothing.

```sh
# The same thing locally, against the same kind of account.
STRIPE_API_KEY=sk_test_… pnpm --filter @potion.run/paykit-stripe test
POLAR_ACCESS_TOKEN=… pnpm --filter @potion.run/paykit-polar test
```

Expect them to create and retire prices/products in those test accounts; both start with
`stack.destroy()` and leave retained objects behind, which is the point of the rule and a mess in a
shared account. Use dedicated test accounts — once `RetiredPrices` lands, a sweep over
`paykit:<stage>:*` archives what it thinks the catalog abandoned, which is only safe where everything
in the account came from the sweep. The Polar case is pinned to `server: "sandbox"`, so a production
token cannot reach production.

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
