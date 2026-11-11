# @potion.run/paykit

Billing and entitlement for Alchemy. You declare a catalog next to your stack, paykit keeps each
account's **standing**, and `check()` answers from one local read.

A subscription is not a payment. A payment is an event that changes a standing. Every rule in
this package derives from that sentence. [PLAN.md](https://github.com/potion-run/paykit/blob/main/packages/paykit/PLAN.md) is the design of record; this
README is the quickstart and the honest status of what ships today.

> **Status:** the plan/customer/balance API in
> [ADR 0035](https://github.com/potion-run/paykit/blob/main/docs/adr/0035-plans-plan-items-and-balance-sources.md) has landed. The public
> words are `Plan`, `PlanItem`, `Feature`, `Customer` and `Balance`; the bindings are named after
> their commands, and `Paykit.plan()` / `Paykit.planItem()` are the authoring calls.

:::warning
The ledger is application data, not stack state. Use `RemovalPolicy.RETAIN` on catalog and account
resources, and never let a `destroy` cancel, refund or delete provider state. A `destroy` that
cancels a live subscription is a support incident.
:::

## Two planes

| Plane | Owner | Rule |
| --- | --- | --- |
| Entitlement | paykit | `check()` answers from one local read: allowed, remaining, `resetsAt`, standing. No provider round trip. |
| Money | the provider | Checkout, cards, tax, invoices and retries sit behind the `Payments` port. |

A provider call never decides an entitlement. Every "just read it from the provider" is a
migration you will owe later.

## Quickstart on `Memory`

```ts
import * as Paykit from "@potion.run/paykit";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const messages = Paykit.feature({ id: "messages", name: "Messages" });

const free = Paykit.plan({
  id: "free",
  name: "Free",
  grants: [Paykit.planItem(messages, { included: 100 })],
});

const pro = Paykit.plan({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.planItem(messages, { included: 2000, overage: "bill" })],
});

const billing = {
  catalog: { features: [messages], tiers: [free, pro] },
  providers: [Paykit.Memory()],
  store: Paykit.MemoryStore(),
};

// The deploy validates and records the declaration.
const recorded = yield* Paykit.BillingStack("Billing", billing);

// The runtime graph: the model, the catalog, the router and the bindings.
// A Worker passes its platform; a test and `alchemy dev` take the default.
// A development header guard; a production deployment provides its own session.
const World = Paykit.world({ ...billing, guards: Paykit.InsecureDevGuards });

yield* Effect.gen(function* () {
  const subscribe = yield* Paykit.Subscribe("acct_1");
  const track = yield* Paykit.TrackUsage("acct_1");
  const check = yield* Paykit.Check("acct_1");

  yield* subscribe({ tier: "free" });
  yield* track({ featureId: "messages", value: 1, idempotencyKey: "req_1" });

  const answer = yield* check({ featureId: "messages", requiredBalance: 1 });
  // { allowed: true, balance: { remaining: 99, ... }, standing: "good" }
}).pipe(Effect.provide(World));
```

`track` records usage in the same transaction that checks the allowance. A `block` allowance
refuses with `AllowanceExceeded` before anything is written. An `idempotencyKey` is also the command
id, so a retry records once. `check` answers with the whole `Balance` for the feature; `Paykit.Balances`
lists it, reads it, writes seat occupancy and finalizes a lock.

## The catalog

`Plan`, `PlanItem`, `Feature`, `Customer`, `BillingControls`, `Balance`, `Subscription`, `Period`, `Usage` and
`Standing` are the public words. `Tier` and `Allowance` are the internal schema names the state is
written in; the events speak plan, the advanced command bindings keep their `Tier` names, and new
code uses `plan()` and `planItem()`.

```ts
const seats = Paykit.feature({ id: "seats", name: "Seats" });

const team = Paykit.plan({
  id: "team",
  name: "Team",
  price: { amount: 4900, currency: "usd", interval: "month" },
  grants: [
    // Rollover: what the month did not spend carries into the next one, at
    // most one month's worth, so `remaining` can pass `included`.
    // `cap` bills up to 10,000 units past `included` this period, then stops —
    // a ceiling in the feature's own unit, not in money.
    Paykit.planItem(Paykit.messages, {
      included: 10_000,
      overage: "bill",
      carryOver: true,
      cap: 2_000,
    }),
    Paykit.planItem(seats, { included: 10, overage: "block", resets: "never" }),
  ],
});

// An allowance that never runs out. Past it there is nothing to block or to
// bill, so `overage` defaults to "allow" and the catalog refuses any other.
const scale = Paykit.plan({
  id: "scale",
  name: "Scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [Paykit.planItem(Paykit.messages, { included: "unlimited" })],
});

// An on/off capability. A flag is declared once, then granted — not metered:
// `check()` answers allowed and there is no counter to spend or to reset.
const sso = Paykit.feature({ id: "sso", name: "SSO", kind: "flag" });

const enterprise = Paykit.plan({
  id: "enterprise",
  name: "Enterprise",
  price: { amount: 49_900, currency: "usd", interval: "month" },
  grants: [Paykit.grant(sso), Paykit.planItem(Paykit.messages, { included: 50_000 })],
});

// A feature priced in credits: a unit costs credits by the dimension that
// served it, and the tier grants the pool they are drawn from.
const ai = Paykit.feature({
  id: "ai",
  name: "AI",
  creditRates: { default: 1, "gpt-large": 10 },
});

const credits = Paykit.plan({
  id: "credits",
  name: "Credits",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  credits: 50_000, // granted on activation; `creditsExpire: "period"` is the default
  grants: [Paykit.planItem(Paykit.messages, { included: 50_000 })],
});

Paykit.catalog({
  features: [Paykit.messages, seats, sso, ai],
  tiers: [team, scale, enterprise, credits],
});
```

### Pricing a feature

A billed allowance states one price, and the price is a function of the billable
count rather than a rate on one unit:

```ts
// $5 for each 1,000 calls. 1,500 calls is two packages.
Paykit.planItem(Paykit.messages, {
  included: 0,
  overage: "bill",
  pricing: { kind: "unit", amount: 500, currency: "usd", units: 1_000 },
});

// The first 10,000 calls at $0.01, then $0.005.
Paykit.planItem(Paykit.messages, {
  included: 0,
  overage: "bill",
  pricing: {
    kind: "graduated",
    currency: "usd",
    bands: [
      { upTo: 10_000, amount: 1, currency: "usd" },
      { upTo: "inf", amount: 5, currency: "usd", units: 1_000 },
    ],
  },
});
```

`volume` states the same bands but charges every unit at the band the total
lands in. One event's charge is the price after it minus the price before it, so
the order two events arrive in cannot change the period's bill, and the event
carries one `PricedLine` per price it crossed.

### A rate card, not a rate

A credit-priced feature can price on the event's properties instead of a name the
caller translates:

```ts
const compute = Paykit.feature({
  id: "compute_minutes",
  name: "Compute minutes",
  rateCard: {
    default: 1,
    rules: [{ match: { size: "large" }, credits: 16 }],
    multipliers: [{ match: { lifecycle: "spot" }, factor: 0.3 }],
  },
});

// A large spot machine: 16 credits × 0.3 = 5 credits a unit.
yield* track({
  featureId: "compute_minutes",
  value: 10,
  idempotencyKey: requestId,
  properties: { size: "large", lifecycle: "spot" },
});
```

A named dimension wins first, then a matching rule, then `default`; every
matching multiplier applies and the rate never goes below zero. `Tier.rateCard`
replaces one feature's card for that tier.

### Seats

A seat is a quantity, not a counter. Declare a non-consumable feature, grant a
free quantity and price the additional ones:

```ts
const seats = Paykit.feature({ id: "seats", name: "Seats", kind: "non_consumable" });

const team = Paykit.plan({
  id: "team",
  price: { amount: 4_900, currency: "usd", interval: "month" },
  grants: [
    Paykit.planItem(seats, {
      included: 5, // free seats
      overage: "bill",
      pricing: { kind: "unit", amount: 1_000, currency: "usd" }, // $10 a seat
      cap: 20, // the most the account may hold
    }),
  ],
});

const setQuantity = yield* Paykit.SetQuantity(account);
const { quantity, proration } = yield* setQuantity({
  feature: "seats",
  quantity: 8,
  dedupeKey: "seats:2026-11-06",
});

// A positive proration is collected by the provider.
if (proration !== undefined && proration.due > 0) {
  yield* (yield* Paykit.ChargeQuantityProration(account))({
    prorationId: "seats:2026-11-06",
  });
}
```

`SetQuantity` sets the total **purchased**, including the free grant; the
billable difference is prorated for the rest of the period, and
`prorate: "period_end"` defers the charge to the boundary. Occupancy is its own
write: `balances.update({ featureId: "seats", usage: members.length })` records
how many seats are in use, and `remaining` is `purchased - occupied`. It may be
negative — a purchase below occupancy never removes a seat — and `check()` then
answers `allowed: false` for a new seat while the people already using one keep
working (ADR 0036).

A provider that declares `quantity` is told the new total and updates the
subscription: Stripe updates the item and invoices the difference, while Polar
updates the subscription's one seat count for the next renewal and leaves the
immediate charge to the local collector. The invoice a provider opens is
recorded on the pending proration. A provider without `quantity` keeps
the local path, and `ChargeQuantityProration` collects it. `TrackUsage` and
`Hold` refuse a seat with `FeatureNotConsumable`. The row carries `quantity`
(purchased), `used` (occupied), `included`, `cap` and `remaining`.

### Balance sources

A balance is a list of sources, not one number. `Balance.breakdown` reports one plan item per
active plan, the rollover and every standalone grant, and a spend takes from them in that order: the
plan sources in plan-set order, then rollover, then an expiring grant, then a lifetime grant.

```ts
const balances = yield* Paykit.Balances(account);

// A lifetime grant. The plan and rollover are spent first, and a plan change
// leaves it alone (ADR 0037).
const granted = yield* balances.create({
  featureId: "research_runs",
  grantedBalance: 50,
  reset: { interval: "one_off" },
});

// An expiring grant. BalanceExpiry schedules ExpireGrant at the deadline.
const promo = yield* balances.create({
  featureId: "research_runs",
  grantedBalance: 20,
  expiresAt: DateTime.add(DateTime.makeUnsafe(Date.now()), { months: 1 }),
});

for (const source of granted.breakdown) {
  console.log(source.kind, source.remaining);
}
```

`balances.create` is for a counted, non-flag feature. A credit-priced feature's pool is still the
`credits` / `prepaidCredits` pair; its breakdown derives the plan and one-off sources from those.

### Resets, variants and currencies

`resets` runs from `hour` to `annual`, and `resetEvery` counts intervals, so a
monthly plan can grant a daily allowance (`{ resets: "day" }`) or a four-hour one
(`{ resets: "hour", resetEvery: 4 }`). A monthly or annual allowance resets with
the period; every other schedule has its own boundary and its own
`ResetAllowance` command. `carryCap` bounds what one window may carry.

A tier can be a named alternative of another, stating only what it changes:

```ts
const annual = Paykit.plan({
  id: "pro_annual",
  variantOf: "pro",
  customize: { price: { amount: 19_000, currency: "usd", interval: "annual" } },
});
```

A price can also be sold in more than one currency with
`additionalCurrencies`, and `priceFor(price, "eur")` resolves the amount. A tier
with postpaid prices sells in one currency: a metered unit price is stated once.

A feature is declared once and quoted by identity, so a tier cannot grant a feature the catalog
never declared. `catalog()` refuses duplicate feature ids, duplicate tier ids, a tier that grants
the same feature twice, a tier with no grants, an unlimited allowance that also names a `block` or
`bill` overage (`CatalogUnlimitedOverage`), a `kind: "flag"` feature granted a count
(`CatalogFlagNotGranted`), `carryOver` on a flag (`CatalogCarryOverOnFlag`) or beside
`resets: "never"` (`CatalogCarryOverNeverResets`), a rate card with no `"default"`
(`CatalogCreditRateMissing`), a rate that is not a positive integer (`CatalogCreditRateInvalid`), an
allowance for a credit-priced feature (`CatalogCreditFeatureHasAllowance`), a rate card on a flag
(`CatalogCreditRatesOnFlag`), an impossible credit grant (`CatalogCreditGrantInvalid`), a `cap`
where nothing is billed (`CatalogCapWithoutBilling`), a price where nothing is billed (`CatalogPricingWithoutBilling` or
`CatalogUnitPriceWithoutBilling`), a money cap with no price
(`CatalogMoneyCapWithoutUnitPrice`), mixed pricing currencies
(`CatalogUnitPriceCurrency`, `CatalogPricingCurrency`), bands that are out of
order or do not end at `"inf"` (`CatalogPricingBand`), a volume ladder whose rate
rises (`CatalogVolumeRateRises`), two prices on one allowance
(`CatalogPricingConflict`), a rate card and a rate map on one feature
(`CatalogRateCardConflict`), a card override for a feature the catalog does not
price in credits (`CatalogRateCardOverride`), a variant whose base is missing or
cyclic (`CatalogUnknownVariant`, `CatalogVariantCycle`), a repeated currency
(`CatalogAdditionalCurrency`), a
top-up line on a one-off pack (`CatalogTopUpOnPack`), and a price that is not positive whole minor
units.

`kind: "flag"` declares an on/off capability: a tier `grant`s it or does not, `check()` answers
`{ allowed, remaining: null, resetsAt: null, standing }`, and `Track` and `Hold` refuse it with
`FeatureNotMetered` because there is no counter behind it.

`cap` is a ceiling in the feature's own unit: the most a period may bill past `included`, so
`included + cap` units. `Track` and `Hold` both refuse past it with `SpendCapExceeded` — a hold
counts, because a hold is a promise to bill — and `check()` answers `allowed: false` at the ceiling
while the standing stays `good`, because the account is out of what it bought, not in trouble. It
needs `overage: "bill"` (`CatalogCapWithoutBilling`).

`carryOver: true` rolls what a period did not spend into the next one, at most `included`: the new
period starts at `included + clamp(unspent, 0, included)`, `used` returns to `0`, and the read model
carries the rolled-over amount so a console can show it.

`creditRates` prices a feature in credits instead of units. One pool per account: every
credit-priced feature reports the same `remaining`, `track({ featureId, value, dimension })` spends
`value × rate` from it, and a request the pool cannot cover is refused with `CreditExceeded`.
`check({ featureId, requiredBalance, dimension })` prices the request before comparing it, so it
answers from the same local read. A tier grants the pool with `credits`, and `creditsExpire: "period"` (the
default) zeroes it at a period close while `"never"` keeps it. A tier may also state `topUp`: the
whole auto top-up line — `threshold` (the credit line at or below which a spend is a crossing),
`cooldown` (the shortest time between two purchases on this tier) and `pack` (the `kind: "one_off"`
tier to buy). A one-off pack cannot state one.

A postpaid allowance states a `unitPrice` in minor units and optionally a `moneyCap`. The billable
part is only what is past `included`; `track()` records the charge and the feature's period total,
and a request that would pass the money ceiling is refused with `MoneyCapExceeded` while the standing
stays `good`. `check()` prices the requested amount from the same local read. A tier's unit prices
share one currency.

The vendor uses the same number: `StripePrices` and `PolarPrices` create a metered price from the
allowance's `unitPrice`, `Stack` refuses a provider mapping that disagrees, and the
`PeriodCloseUsage` policy sends the closing period's billable quantity (`used - included`) to the
provider once, with the period as the idempotency key. A provider without a meter declares no
`usage` capability, and the close fails with `ProviderCapabilityMissing` rather than billing only in
local state.

A `kind: "one_off"` tier is a prepaid pack: it grants credits, has no allowances, defaults
`creditsExpire` to `"never"`, and must state a price. Buying it opens a one-time provider payment
(Stripe `mode: "payment"`, a one-time Polar product) rather than a subscription, and
`payment_succeeded` grants the credits. There is still one pool, but the part a pack bought is
protected: a period close expires only the plan's credits, and spending drains the plan's first.

A deployment can also refill the pool itself. `autoTopUp({ catalog, pack, cooldown? })` provides a
policy that buys a `kind: "one_off"` pack when a spend takes the pool from above the tier's
`topUp.threshold` to at or below it: it asks the account's provider for the pack's price as an
invoice keyed by the crossing, and records the purchase with that invoice id. The line is catalog
data on the tier and rides the standing's events, so a tier states when it refills, how often
(`topUp.cooldown`, which overrides the deployment's) and with what (`topUp.pack`, which overrides the
deployment's default); a tier without one never refills. Only a spend crosses — a grant, an expiry or a hold
reservation does not — and one crossing buys one pack, so the next refill costs at least the pack's
credits in spending. A deployment that never provides the layer pays nothing for the policy.

A refill that cannot be bought is a fact, not a defect: when the provider refuses both the saved
method and the invoice, the policy records `TopUpFailed` — the pack, the provider, the refusal's tag
and the crossing — and leaves the pool exactly where the spend left it. The standing carries it as
`topUpFailure`, `BillingState` shows it, and the timeline renders a `topup-failed` entry with no money
on it. The next successful purchase clears it, and the cooldown the crossing opened is what retries.

`included: "unlimited"` grants an allowance with no end. `check()` answers
`{ allowed: true, remaining: null, resetsAt, standing }`: `remaining` is `null` because there is no
count to report, and `resetsAt` is still there because the period still exists. `Track`, `Hold`,
`Settle` and `Release` all work on it, `used` keeps its honest count, and `ClosePeriod` resets
`used` without inventing a `remaining`.

The catalog carries no provider ids. A provider maps tiers to its own handles, and `Stack`
refuses a mapping whose amount, currency or interval disagrees with the catalog
(`CatalogPriceMismatch`).

## Runtime

| Binding | Answers |
| --- | --- |
| `Paykit.Check(account)` | `{ allowed, balance, standing }`, one local read (`balance.remaining` is `null` when the allowance never runs out) |
| `Paykit.TrackUsage(account)` | records a usage fact, deduped by `idempotencyKey`, atomically with its allowance check |
| `Paykit.Subscribe(account)` | a hosted checkout URL, an invoice id, or `{ activated: true }` for a free tier |
| `Paykit.Portal(account)` | the provider's customer portal, when it declares one |
| `Paykit.Webhook()` | the webhook edge as a binding: `(event) => WebhookAction`, services resolved once |
| `Paykit.handler({ provider })` | the deployment's paths as a request function and as `handler.fetch`, an `HttpEffect` that reads the ambient request |

All money is `Schema.Int` minor units with a currency on every amount. A provider that does not
implement an optional op fails with `ProviderCapabilityMissing`; nothing degrades silently.

A `Hold` is an addressable reservation for work in flight: `Settle` bills what ran and returns the
rest in the same call, `Release` returns all of it, and a hold left open is released by `HoldSweep`
at its `expiresAt` (fifteen minutes by default). `reserved` on the read model is the fold of the
open holds, not a counter a command writes.

## SQL hosts

`SqlEventLog`, `SqlPlatform` and `SqlBillingReadStore` are the SQL world; the
driver is the one platform-specific piece. `Paykit.d1Executor` adapts a D1
binding, and `Paykit.postgresExecutor` adapts Alchemy's
`@alchemy.run/sql/Postgres` client (an `@effect/sql-pg` pool) — which is what a
Worker uses through Hyperdrive. The driver owns the placeholder dialect, the
transaction and its isolation; the store states what belongs together and the
driver decides how.

```ts
const client = yield* SQL.Postgres({ url: hyperdrive.connectionString });
const sql = Paykit.postgresExecutor(client);
const log = Paykit.SqlEventLog(sql, { now, schema: "billing" });
const { platform } = Paykit.SqlPlatform(sql, log, { now, schema: "billing" });
```

`examples/postgres` is the whole wiring: a Hyperdrive configuration, Alchemy's
migration registry at deploy, and one Worker.

## Providers

| Provider | Kind | Required purchase path | Optional ops |
| --- | --- | --- | --- |
| `Paykit.Memory()` | memory | checkout + invoice | refund, portal, usage |
| `Paykit.Manual()` | manual | invoice | refund |
| `Paykit.Stripe({ bindings, tiers })` | processor | checkout | invoice, refund, portal, usage |
| `Paykit.PaymentsPolar({ bindings, tiers })` | merchant of record | checkout | refund, portal, usage |

`Polar` itself — the one-call provider — is [`@potion.run/paykit-polar`](https://github.com/potion-run/paykit/tree/main/packages/paykit-polar), and
`Stripe`'s is [`@potion.run/paykit-stripe`](https://github.com/potion-run/paykit/tree/main/packages/paykit-stripe). `PaymentsPolar` and `PaymentsStripe`
here are the port mappings those packages wrap, for a caller who brings its own bindings.

A Stack can run several providers. `Paykit.paymentsRouter(...)` holds them by name, and each call
resolves the provider the account's `refs` already name — falling back to the first — so an account
sold through one provider never gets upgraded through another. Names must be distinct.

`Manual` is the reference: if the port only fits Stripe, it is not a port. Every provider runs
the same conformance suite in [`test/conformance`](https://github.com/potion-run/paykit/tree/main/packages/paykit/test/conformance), parameterized by the
capabilities it declares.

The Stripe and Polar adapters take the bindings (`StripeBindings`, `PolarBindings`) a vendor
package supplies: `@potion.run/paykit-stripe` and `@potion.run/paykit-polar`. Those own HTTP, auth,
signatures and the webhook decoder; paykit owns the model.

Each vendor package also provisions its side of the catalog. `StripePrices` creates one product and
base price per priced tier, plus a billing meter and a metered price for every `usage` feature, and
returns `{ prices, usage, meters }`; `PolarPrices` creates one product per tier with its fixed and
metered prices, plus one meter per `usage` feature, and returns `{ products, meters }`. `StripeBilling`
and `PolarBilling` join provisioning and the provider in one call for the common deployment; a
deployment that configures them separately hands the `meters` map and the per-tier `usage` prices to
`Stripe({ tiers, meters })` or `Polar({ tiers, meters })` so the runtime can report the close. Both
keep retired prices, products and meters in the vendor, and neither lets a provider id into the
catalog.

## The model

One aggregate keyed by account holds both the standing and its usage counters. A view folds one
account's events; lists and dashboards come from the `BillingRead` projection, never from a view.

A bill's story is a fold over the same `AccountEvents` the console already watches:
`timelineOf(entries)` / `appendTimeline(timeline, entry)` return one entry per billing fact in log
order, each stamped with the period it happened in, plus a per-period and per-feature rollup of
units, credits and money. It is a fold, not a second log: the raw stream stays the audit trail, and
nothing in `check()` or `decide` reads it.

```ts
Paykit.Model; // the Domain model
Paykit.BillingApi; // tenant commands, Entitlements, BillingState, AccountEvents
Paykit.BillingAdminApi; // GrantCredits, ExtendTrial, ChangeTier, Subscription reads
```

The console's own surface is `AdminConsoleRpcs` from `@potion.run/paykit/Admin`: the
cross-account reads, the tier-change quote/apply, and the refund. `AdminConsoleServer` serves all
three through one `Admin` middleware. `AdminRefund` is the one that needs the provider, so the
process that serves it must be provided `Paykit.Refund` (the admin binding); `BillingAdminApi`
deliberately has no refund, because an Api backend that cannot reach the provider must not take
money out.

Commands are pure decisions, events carry the outcome, and `evolve` copies it. `Domain.verify`
is empty for the shipped model. Events are public API: add a field, never rename one.

A command carries the resolved allowances for its tier because the aggregate has no catalog of
its own. The runtime `Subscribe` binding resolves them server-side; a tenant `BillingApi` that
exposes `Subscribe` or `ChangeTier` directly must put the same resolver behind its middleware.
`TrackUsage` carries no allowances and is safe to expose as is.

## Status

Implemented and tested:

- M0 foundation: catalog, model, `Domain.InMemory` hosting, `Check`, payments memory.
- M2 usage: allowances, overage modes, dedupe, scheduled period rollover and reset, the
  scheduled sweep of expired holds, replay and allowance properties.
- M3 catalog and adapter shape: `Stack` validation, `Manual` reference provider, Stripe/Polar
  adapters over their bindings, one conformance suite, the `BillingStack` resource with a
  retain default, and the provider webhook edge (provider event id as the command id).
- M4 money commands: checkout start/complete, payments, grace, scheduled grace expiry
  (dunning), credits, prepaid packs, postpaid money and money caps, the vendor meter at close,
  proration property, cancellation and resume.
- M5 admin and reads: `BillingAdminApi`, the `AccountEvents` stream, the `BillingRead`
  projection, and the three `Check` read paths (in-process, read model, HTTP transport).
- M1: the SQL event log with receipts, outbox, schedule and per-account locking; migrations through
  `@alchemy.run/sql/Migrations` (content hashes, drift detection, custom schema, dry-run DDL); the
  full `SqlPlatform` hosting aggregates, views, policies, projections and streams; `doctor`
  rebuilding the read model and naming the event ids that disagree.
- SQL history: a view or projection added later, or rebuilt by a version bump, is caught up from
  `billing_event` by `SqlPlatform.start`; a view keyed by its one aggregate fills each key on first
  touch, so a version bump does not need a deploy-time scan. `billing_rm_backfill` records the
  generation and plan, so a restart skips a completed consumer and a changed plan without a version
  bump fails the build. `SqlViewStore`/`SqlProjectionStore` reset storage from an earlier generation
  and drop deliveries routed to it.

Not shipped yet, and deliberately not faked:

- A `paykit migrate` / `paykit doctor` CLI; the library effects (`migrate`, `migrateDryRun`,
  `doctor`) are ready for it.
- A durable checkout saga across a crash (the checkout start/complete flow works today).

## Test layout

| Suite | Proves |
| --- | --- |
| `test/stories` | every command's happy path and every rejection |
| `test/properties` | generated command sequences for replay, allowances, holds, lifecycle, credits, pricing, proration and paging |
| `test/conformance` | every `Payments` implementation passes the cases its capabilities declare |
| `test/sql` | the event log's transaction, dedupe and read-model contract, plus migration apply, drift and dry-run |
| `test/providers` | each adapter's own price mapping, optional capabilities and typed refusals |

Properties are generated and shrunk with `effect/Arbitrary`. A failing property prints its
smallest counterexample and a replay token; the token goes back into `replay` to reproduce it.

Run the gates from the repo root: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Further reading

- [PLAN.md](https://github.com/potion-run/paykit/blob/main/packages/paykit/PLAN.md) — the design of record.
- [AGENTS.md](https://github.com/potion-run/paykit/blob/main/AGENTS.md) — the rules for changing any package in this repo.
