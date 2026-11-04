# What to build next

A handoff for whoever (or whatever) picks this up cold. The state, the queue, the traps, and how the
last few slices were done. Nothing here overrides the ADRs in [`docs/adr/`](./adr/); where they
disagree, the ADR wins and this file is wrong.

## Where it stands

`@potion.run/paykit` is at `0.1.0`, unpublished and never deployed. Three packages publish together
(`paykit`, `paykit-polar`, `paykit-stripe`) on one version line. The gates are green: `format:check`,
`lint`, `typecheck`, `test` (409 tests across the four projects, one skipped), `build`,
`exports:check`, `validate:publish-packages`.

What the catalog can express today: units with `block | bill | allow`, `"unlimited"`, `kind: "flag"`
grants, `carryOver`, credits with a per-dimension rate card (`creditRates`), and a spend cap
(`cap`). What the runtime can do: `check` from local state, `track`, `hold`/`settle`/`release` as
addressable entities, proration, dunning, trials, credits, and a provider-port edge with webhook
decoders for Stripe and Polar. What the deploy does: validates the catalog into `BillingStack`, and
`StripePrices` creates the prices its tiers are sold under.

The five records behind that: [0001](./adr/0001-catalog-states-the-pricing-model.md) (pricing is
catalog data, the deploy provisions the vendor), [0002](./adr/0002-credits-are-the-unit-of-account.md)
(credits are a unit of account, one pool per account), [0003](./adr/0003-the-deploy-provisions-the-vendor.md)
(identity by lookup key, replace on change, never delete), [0004](./adr/0004-a-hold-is-one-call-and-an-id.md)
(a hold is an entity, one call settles it), [0005](./adr/0005-a-spend-cap-is-a-ceiling-in-units.md)
(a cap is a count, not money).

## The queue

Ordered by value per unit of work. Each is small enough to finish in one pass and leave green.

### 1. Sweep expired holds — ADR 0004 §2

**Why.** A hold records `expiresAt` (15 minutes) and `Settle` refuses past it, but nothing returns
the units. A caller that crashes between `Hold` and `Settle` keeps capacity until an operator
releases it by hand.

**Where.** A policy beside `PeriodRollover` and `Dunning` in `src/Subscription/`, registered in
`PaykitModel`. It issues `ReleaseHold` for holds whose `expiresAt` has passed, using the same
scheduled-command path the other policies use.

**Done when.** A hold past its expiry is released by the policy without a caller doing anything; the
release is idempotent (a late `Settle` still refuses, a late `Release` is a replay); a story test with
a clock jump proves it; `reserved` and `reservedCredits` go back to zero afterwards.

**Trap.** Do not release on a timer inside `decide` — `decide` is pure and time arrives as command
data or from the supplied `Clock`. The policy reads the clock; the command does not.

### 2. Price a Polar product from the catalog — ADR 0003 §2c

**Why.** Provisioning is Stripe-only, so half of every "the deploy creates it" sentence is false for
the merchant-of-record path.

**Where.** `packages/paykit-polar/src/Prices.ts`, mirroring `packages/paykit-stripe/src/Prices.ts`:
`priceDeclarations(tiers, stage)`, a `PolarPrices` helper that yields one product per tier and returns
the tier → lookup-key map, `RemovalPolicy.retain()` on each resource, and a gated live test
(`POLAR_ACCESS_TOKEN`) written the way `Prices.live.test.ts` is.

**Done when.** The same three rules hold — identity in the vendor's own field (Polar has no lookup
key; use `metadata.paykit_tier` and a stage-qualified name), replace on a price change, retain on
retire — and the gated live case proves it against the sandbox.

**Trap.** Polar embeds prices in the product where Stripe models a price as an object of its own. The
difference must stop inside `paykit-polar`; `paykit`'s `PolarTier` keeps its `{ price, productId }`
shape.

### 3. Prepaid — ADR 0002 §2

**Why.** `creditsExpire: "never"` already exists, but a tier that grants credits is still a
subscription. Selling credits on their own is the first thing in this queue that crosses into the
money plane, and it is what "buy 1M credits for $99" needs.

**Where.** `Tier.kind: "subscription" | "one_off"` in `src/Tier.ts`; a purchase path in
`src/Subscribe.ts` that opens a provider payment rather than a subscription; the provider `createCheckout`
call gains a one-off mode on Stripe (`mode: "payment"`) and Polar.

**Done when.** A one-off tier can be bought without creating a subscription, its credits are granted
on `payment_succeeded`, and a period close does not touch them.

**Trap.** `Catalog`'s "one standing per account" rule still holds: buying credits must not create a
second subscription, and `TierChanged` must not be how credits arrive.

### 4. Postpaid usage, and money caps with it

**Why.** The last ADR 0001 row. It is also what unblocks a **money** cap: ADR 0005 says a cap is a
count because the catalog has no unit price, and postpaid pricing is where a unit price legitimately
enters.

**Where.** A `unitPrice` on the feature or on the allowance, a metered price on the vendor side, and
usage records pushed to the provider at period close. This is mostly money plane, not model.

**Trap.** `decide` must stay pure: a unit price in the catalog is fine, a *provider read* to fetch it
is not.

### 5. The surfaces the model already supports

- **Outbound events** (ADR 0001 §Slice 3): an app that hears "this account upgraded" without polling
  `AccountEvents`. Sign and retry like the inbound edge, reversed.
- **Console screens**: balances, usage timeline, "why is this account on pro" (`Preview` answers it),
  open holds with their age, manual grant, refund.
- **Archived prices** (ADR 0003): a retired price is currently retained but stays `active: true`.
  Archiving needs a vendor write against a resource the stack no longer tracks — a sweep by lookup-key
  prefix is the obvious shape.

## The one thing that has never been run

`packages/paykit-stripe/test/Prices.live.test.ts` is gated on `STRIPE_API_KEY` and reports **skipped**
in every run so far. It is the only proof that `StripePrices` works against a real API, and the only
place the "replace keeps the old price" claim is actually tested.

```sh
STRIPE_API_KEY=sk_test_… pnpm --filter @potion.run/paykit-stripe test
```

Run it before trusting provisioning, and before publishing anything that advertises it. Expect it to
create and retire prices in that test account; it starts with `stack.destroy()` and leaves retained
prices behind, which is the point of the rule and a mess in a shared account.

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
- **Events carry the money.** `UsageRecorded.cost`, `Pricing`/`TierChanged` prices, the captured hold
  rate — a replay must reproduce every number, and a catalog change must never reprice history.
- **A cap is quantity, not standing.** `allowed: false` at a ceiling while `standing` stays `good`.
- **A missing capability is a tag.** `ProviderCapabilityMissing`, never a silent no-op.
- **Nothing is deleted that a bill references.** Prices are retained; the event log is the record.
