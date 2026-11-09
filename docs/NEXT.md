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
grants, `carryOver` with a `carryCap`, credits with a rate card (a `creditRates` shorthand, or a
`rateCard` with property `rules` and `multipliers`, overridable per tier), a spend cap (`cap`), a
postpaid price with a `moneyCap` — one rate, a package (`units`), or a `graduated` / `volume` band
ladder — every reset interval from `hour` to `annual` with a `resetEvery` multiplier, a per-tier auto
top-up line (`topUp`), a `kind: "one_off"` credit pack, additional currencies on a tier price, and a
`variantOf` / `customize` tier variant, and a `kind: "non_consumable"` quantity (seats) with a
free grant, a cap, a per-seat price and `SetQuantity` / `ChargeQuantityProration`. A reset the
period does not own is its own command (`ResetAllowance`), and a banded price records one
`PricedLine` per price an event crossed. What the runtime can do, as
command-named bindings: `Check` from local state, `TrackUsage`, `SetQuantity` for a seat change
(the vendor's subscription-item quantity when the provider declares `quantity`, otherwise
`ChargeQuantityProration` collecting the local proration), `Hold`/`SettleHold`/`ReleaseHold` as
addressable entities, a policy that releases a hold on its own deadline,
proration, dunning (an opt-in retry ladder that charges the saved method and records each
attempt before grace expires), trials, credits, bought packs whose credits survive a period close
and are spendable before a plan exists, auto top-up (a spend that crosses the standing tier's line charges
the saved method, or invoices it, and records the pack against that charge or invoice, with an
optional cooldown that defers the next refill to a scheduled deadline), a usage timeline folded from
the account's events (one
entry per
billing fact, plus a per-period, per-feature rollup), postpaid usage priced per unit with a money
cap, an outbound edge
that signs and retries every committed event, and a provider-port edge with webhook decoders for
Stripe and Polar, which archiving sweeps keep a retired price or product from being sold
(`RetiredPrices` in Stripe, `RetiredProducts` in Polar), and the Stripe seat prices and Polar seat count that let
the subscription own a seat quantity. What the deploy does: validates the catalog
into `BillingStack`, and `StripePrices` / `PolarPrices` create the base prices and products its tiers
are sold under, plus a meter and a metered price for every postpaid feature — a package as the
vendor's quantity transform, a ladder as its tiered price. What the close does: `PeriodCloseUsage` sends the closing
period's billable units to the account's provider once, with the period as the idempotency key.

The client surface has a first-class Effect Atom module (`@potion.run/paykit/Atom`): `make` builds
one runtime over the tenant Api, `entitlements(account)` and `billing(account)` are queries memoized
per account, every tenant verb is a command atom, and a successful command invalidates
`paykit/account/<id>` so the queries refresh without a manual call. `examples/tanstack` deploys it in
a TanStack Start app on Alchemy, with the purchase operation left in the Worker that owns the
provider.

A deployment serves itself with `Paykit.handler`, which mounts the four paths every deployment has
and leaves the rest to `routes`. Two money facts the log used to lose are recorded now: `TopUpFailed`,
when a provider will not collect a refill, and `RefundReversed`, when a provider takes a refund back.
Both are evidence that moves no counter, and both fold into the timeline.

The spend path is modelled in Quint ([ADR
0034](./adr/0034-one-quint-model-per-protocol.md)): `specs/paykit/paykit.qnt` is one machine —
activation, counted and credit usage, holds, the pool, the standing, the clock — with seven
invariants, and `pnpm spec` simulates ten thousand traces on every push. It is the gate the property
suite cannot be: `walk()` folds one sequential script, so it never interleaves a sweep with a settle
or races two holds against one spend. `scripts/spec-coverage.ts` holds the model's table against all
35 commands, so a command lands either modelled or with a written reason. Two things it surfaced are
recorded rather than fixed: a credit-priced feature's stored `remaining` is stale after
`ConsumeCredits` (nothing observable reads it), and the pool has no counter for a direct consume.

The seven records behind that: [0001](./adr/0001-catalog-states-the-pricing-model.md) (pricing is
catalog data, the deploy provisions the vendor), [0002](./adr/0002-credits-are-the-unit-of-account.md)
(credits are a unit of account, one pool per account), [0003](./adr/0003-the-deploy-provisions-the-vendor.md)
(identity in the vendor's own field, replace on change, never delete), [0004](./adr/0004-a-hold-is-one-call-and-an-id.md)
(a hold is an entity, one call settles it), [0005](./adr/0005-a-spend-cap-is-a-ceiling-in-units.md)
(a cap is a count, not money), [0006](./adr/0006-postpaid-usage-is-a-unit-price-in-the-catalog.md)
(postpaid usage is a unit price in the catalog, and a money cap is a separate ceiling), and
[0007](./adr/0007-outbound-events-are-a-policy-over-a-port.md) (outbound events are a policy over a
delivery port; paykit signs and keys, the app sends). Newer decisions are named beside the slice
they shaped.

The standing's phases are now a read contract beside the model:
`Subscription/StandingPhase.ts` names `Unsubscribed | Trialing | Active | Grace | Expired | Canceled`
with the deadline that moves each and an `overdue` flag for the window between the clock and the
scheduled command. `STANDING_PHASE_TRANSITIONS` is a total table in the shape of Alchemy's
`SQLITE_TRANSITIONS`; `STANDING_PHASE_EDGES` is its annotated view. [ADR
0020](./adr/0020-a-terminal-standing-is-replaced-not-moved.md) makes the terminal edges refusals
(`StandingEnded`) and [ADR 0021](./adr/0021-hold-expiry-is-a-state.md) gives a hold an `expired`
status and a release reason, so a close no longer drops one silently. The table and
`test/standing/Phase.test.ts` are the gate on both.

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

### 0. The model's next slice

`specs/paykit` stops short of the period boundary on purpose: with no reset, `remaining + used +
reserved == included` holds for the life of a standing, which is the cleanest form of the conservation
law. `ClosePeriod`/`PeriodEnded` and `ResetAllowance` are the next slice, and they add `carried` — a
second base the close grants onto, with open holds still subtracted. After that, `SetQuantity` (a
count that is bought, not spent) is the third shape the model does not have. Both rows are already in
`SPEC_COVERAGE` with a reason; turning one into an action is the whole change.

### 1. The remaining surfaces

- **Scheduled tier changes**: done
  ([ADR 0012](./adr/0012-a-tier-change-can-be-scheduled-for-the-boundary.md)). The standing carries
  `pendingTier`, the close applies it before the reset, and `WithdrawTierChange` takes it back.
  `actionsFor` offers the schedule for tiers `ChangeTier` refuses and the withdrawal only while one is
  pending; `Preview` decides both; `BillingState` carries `pendingTier` so a page can say "on pro,
  moving to small at the period end"; the console sends both, building the scheduled payload from the
  catalog it already holds because a scheduled change carries no proration and so needs no quote.
- **Console screens**: `paykit-admin` now shows balances, the period's priced usage, "why is this
  account on X" (`Preview`), open holds with their deadlines, verification against the deploy and a
  manual grant. **Refund** now has its decision ([ADR
  0019](./adr/0019-a-refund-names-the-charge-it-reverses.md), [brief](./briefs/refund.md)) and its
  model: `Refund` records `RefundRecorded`, the ceiling is what the log recorded as charged per
  currency, and the `Paykit.Refund` binding takes the money through `Payments.refund` before the
  command. The screen landed with the model: `AdminConsoleRpcs` carries a `Refund` op whose handler
  runs the in-process binding, `AdminRefundClient` is the browser half, and the console offers the
  action whenever a currency still has money to send back — even for a terminal standing, because a
  refund is money, not a move on the standing. The Api layer still cannot move money; the Worker that
  serves `AdminConsoleServer` must be the one provided `Paykit.Refund`. A refund the provider later
  reverses is its own fact ([ADR 0030](./adr/0030-a-reversed-refund-is-a-second-fact.md)):
  `ReverseRefund` writes `RefundReversed`, capped by the refund it names rather than by the currency,
  and `refunded` moves down so the headroom comes back. It is on the operator Api with the screen
  behind it: `BillingState` carries `refunds`, the console's refunds panel shows what each one
  returned, and a row with money left opens a pre-filled reversal. What is left is a refund that
  revokes credits in the same call.
- **Banded and package prices** are no longer local-only: [ADR
  0024](./adr/0024-a-vendor-meter-can-carry-a-package-and-a-ladder.md) makes
  `usagePrices` the provider contract and maps a package to Stripe's
  `transform_quantity` and both vendors' metered tiers.
- **Archived prices** ([ADR 0010](./adr/0010-a-price-that-leaves-the-catalog-is-archived-not-deleted.md)):
  a retired Stripe price is retained but stays `active: true`, and a retired Polar product stays
  purchasable. Both halves landed: `retiredPrices` decides and `RetiredPrices` lists and deactivates
  in `paykit-stripe`; `retiredProducts` decides and `RetiredProducts` lists and archives in
  `paykit-polar`. The Stripe live case has run and proves a price is archived rather than deleted;
  the Polar live case ran green on 2026-11-09 — [run
  42587268198](https://github.com/potion-run/paykit/actions/runs/42587268198), 71 passed and none
  skipped — so a Polar product is created, retired and archived against the real sandbox.

### 2. Worth building next

**Auto top-up** is done ([ADR
0013](./adr/0013-an-auto-top-up-is-a-purchase-on-a-crossing.md),
[0016](./adr/0016-a-top-up-threshold-is-a-tier-field.md)):
`Paykit.autoTopUp({ catalog, pack })` is a policy over `UsageRecorded` and `CreditsConsumed` that
buys a one-off pack when a spend takes the pool from above the standing tier's `topUp` line to at or
below it. The line is catalog data carried on the standing, so a free tier and an enterprise tier
refill where their own grants run low. The balance before the spend is on the event, so a second
spend below the line is not a second crossing; the pack's price is opened as a provider invoice keyed
by the crossing, and the credits are recorded with that invoice id. What was left landed as two
ADR-first slices: a time cooldown ([ADR
0017](./adr/0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md)) — `Paykit.autoTopUp({ catalog,
pack, cooldown })` records `cooldownUntil` on the purchase, defers a crossing inside the window, and
clears it with a scheduled `TopUpCooldownElapsed` at the deadline — and an off-session charge ([ADR
0018](./adr/0018-a-saved-method-is-a-capability.md)) — an optional `charge` capability the policy
prefers and falls back from to the invoice, recorded as `CreditsPurchased.chargeId`. A provider with
neither capability is still `ProviderCapabilityMissing`, never a free pack. The last three landed
together: [ADR 0026](./adr/0026-a-tier-states-its-whole-top-up-line.md) makes `Tier.topUp` the whole
line — `{ threshold, cooldown?, pack? }` — so a tier states when it refills, how often, and with
which pack, and the deployment's `Paykit.autoTopUp({ pack, cooldown })` is the fallback for a tier
that names neither; [ADR 0027](./adr/0027-a-failed-top-up-is-a-fact-in-the-log.md) records
`TopUpFailed` when the provider refuses both the saved method and the invoice, carries it on the
standing as `topUpFailure`, renders it on the timeline, and leaves the cooldown to retry it. What is
left is a retry budget rather than a cooldown window (a count on the standing and its own refusal),
and a deployment that wants paging on consecutive failures.

**A usage timeline** is done ([ADR
0014](./adr/0014-a-usage-timeline-is-a-fold-over-the-account-log.md)): `timelineOf` /
`appendTimeline` in `Timeline.ts` fold the account's `AccountEvents` into one entry per billing fact
(usage, hold, settle, release, credit moves, payments, tiers, periods), each stamped with the period
it happened in, plus a per-period and per-feature rollup of units, credits and money. It is a fold,
not a table: `lastSeq` makes a redelivery a no-op, the raw stream stays the audit trail, and the
console renders it from the feed it already watches. What is left is a server-side paged timeline
for an account bigger than a browser should hold, and a per-dimension breakdown (the dimension is
on the hold, not on `UsageRecorded`).

One thing the model is one step away from, and why it belongs in a library rather than in a hosted
service. A console is not one of them: what a library owes is the read model a console renders, and
`Preview`, `List`, `BillingRead`, `AccountEvents` and the timeline are that. The screens themselves
are the example's job.

- **Per-customer custom plans.** A `TierChanged` already carries the allowances it granted, so history
  stays exact; what refuses a bespoke deal today is `CatalogGuard`, which will not accept a standing
  whose allowances are not in the catalog. Making that an explicit opt-in (or a declared `custom` tier)
  is a decision, not code, and it is the one thing here a host cannot do for itself.

### 3. The configuration surface

Landed ([the configuration brief](./briefs/billing-configuration.md)). The four examples export one
`billing.config.ts` and pass it to three one-call surfaces: `Paykit.BillingStack` validates and
records, `Paykit.world` builds the runtime graph with the catalog in the layer's error channel, and
`PaykitAtom.make({ url })` builds the browser client, reading the deploy's own catalog from the
served `PaykitCatalogRpcs` read. The catalog constructors are
discriminated unions, so `"unlimited"` beside `overage: "bill"`, a cap without a bill, a flag with a
rate card, and a one-off pack with grants are editor errors; the runtime validator still refuses the
serialized path. `StripeBilling` joins `StripePrices` and `Stripe` into one call, and `PolarBilling`
does the same for Polar: its product ids are `Output<string>`s, so the provider keeps the handle and
resolves it at checkout or webhook time. The browser's catalog copy is gone: [ADR
0028](./adr/0028-a-browser-reads-the-catalog-from-the-deploy.md) serves the deploy's own catalog over
a guarded `Catalog` RPC, and `make` reads it once when the runtime is built, so a stale bundle can no
longer join terms the server refuses with `CatalogMismatch`.

`Paykit.handler` landed beside it ([ADR
0029](./adr/0029-the-request-handler-is-a-primitive.md)): it mounts `/api`, `/admin`, `/checkout` and
`/webhooks`, answers a refusal with `Paykit.httpStatus`, takes the deployment's own paths through
`routes`, and builds no world — it requires the Api services, so one process stays one model.
`Paykit.moneyRoutes(provider)` is promoted beside it, which is where the copy the billing and polar
examples each carried went. What is left is the *join* itself — the Api taking a tier id and the
server expanding it, which needs a tenant command surface because a model command's payload cannot be
enriched between the RPC and `decide`. `examples/polar` is on the handler now, `/` included; the
tanstack example keeps its own adapter because it is a framework entry point, not a path table.

### 4. Auth

The actor model and the resolver seam are in `PLAN.md`; [the auth brief](./briefs/auth.md) records
what landed — `Insecure*` dev guard names, `Forbidden.scope`, and `authenticate(resolve)` for a
route that is not an Api — and the decisions still open: team accounts (`Actor.accounts`), whether
paykit should own a signed session cookie at all, and CSRF/origin checks (which need
`GuardRequest` to carry the method).

## The live cases

Both provisioning packages carry a live test that is gated on a vendor key and reports **skipped** in
every other run. They are the only proof each helper works against a real API, and the only place
the "replace keeps the old one" claim is actually tested.

**Stripe ran green on 2026-11-05**, from `main`, on a test-mode account — [run
41971381878](https://github.com/potion-run/paykit/actions/runs/41971381878), 48 passed and none
skipped. So the price the catalog states is created, replaced on a change, and the replaced one is
retained and still retrievable; the meter and the metered price are created from the same unit price.
**Polar ran green on 2026-11-09**, from `main`, against the sandbox — [run
42587268198](https://github.com/potion-run/paykit/actions/runs/42587268198), 71 passed and none
skipped. Its first runs failed, and every failure was in the case rather than the provider: two cases
sold one tier on one stage (a product's identity is `(stage, tier)`, so only one of them could own
it), a meter could never converge because Polar reports `metadata.units` back as `units`, and two
assertions spelled Polar's encodings as Stripe's. The suite now gives each case its own tier, feature
and logical id, and runs the archive sweep in a stage of its own.

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
- **A timeline is a fold, not a log.** `timelineOf` / `appendTimeline` read `AccountEvents`; they
  store nothing, add no number an event did not carry, and nothing in `decide` or `check` reads
  them. `lastSeq` makes a redelivered event a no-op.
- **A refund is money, not a standing command.** It is offered while `charged - refunded` is
  positive in a currency, even after the standing ends, and its command id is the provider's
  idempotency key. The Api layer has no refund; only the process that holds the provider does.
- **A top-up is a crossing, not a level.** The line is the standing tier's `topUp`, carried on the
  activation, change and schedule events; a tier without one never refills. The balance before the
  spend is on the event (`creditsAfter + cost`, `balanceAfter + amount`), so one crossing buys one
  pack and a spend that is already below the line does not buy a second. The invoice id is on the
  event that records the purchase.
- **A missing capability is a tag.** `ProviderCapabilityMissing`, never a silent no-op.
- **A collection that failed is a fact, a missing capability is a defect.** A declined charge or
  invoice writes `TopUpFailed` (or `PaymentFailed`) and the standing is untouched; a provider that
  declares no way to collect is a deployment error and dies at boot. A failure does not retry by
  itself: a pool already below its line cannot cross it again.
- **A reversal is capped by the refund it names, not by the currency.** Two refunds of one charge are
  two facts, so reversing the second is never refused because the first still stands. `refunded`
  moves down by exactly what came back, and the credit pool is untouched either way.
- **The handler builds no world.** `Paykit.handler` requires `BillingApi` and `BillingAdminApi` and
  never constructs them, so a route cannot answer from a second copy of the model.
- **Nothing is deleted that a bill references.** Prices and products are retained; the event log is
  the record.
