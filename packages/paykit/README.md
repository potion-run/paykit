# @potion.run/paykit

Billing and entitlement for Alchemy. You declare a catalog next to your stack, paykit keeps each
account's **standing**, and `check()` answers from one local read.

A subscription is not a payment. A payment is an event that changes a standing. Every rule in
this package derives from that sentence. [PLAN.md](./PLAN.md) is the design of record; this
README is the quickstart and the honest status of what ships today.

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

const free = Paykit.tier({
  id: "free",
  name: "Free",
  grants: [Paykit.allowance(messages, { included: 100 })],
});

const pro = Paykit.tier({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.allowance(messages, { included: 2000, overage: "bill" })],
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
const World = Paykit.world({ ...billing, guards: Paykit.DevGuards });

yield* Effect.gen(function* () {
  const subscribe = yield* Paykit.Subscribe("acct_1");
  const track = yield* Paykit.TrackUsage("acct_1");
  const check = yield* Paykit.Check("acct_1");

  yield* subscribe({ tier: "free" });
  yield* track({ feature: "messages", amount: 1, dedupeKey: "req_1" });

  const answer = yield* check({ feature: "messages", amount: 1 });
  // { allowed: true, remaining: 99, resetsAt, standing: "good" }
}).pipe(Effect.provide(World));
```

`track` records usage in the same transaction that checks the allowance. A `block` allowance
refuses with `AllowanceExceeded` before anything is written. A `dedupeKey` is also the command id,
so a retry records once.

## The catalog

`Tier`, `Feature`, `Allowance`, `Subscription`, `Period`, `Usage` and `Standing` are fixed words.
Renaming one of them is a breaking change.

```ts
const seats = Paykit.feature({ id: "seats", name: "Seats" });

const team = Paykit.tier({
  id: "team",
  name: "Team",
  price: { amount: 4900, currency: "usd", interval: "month" },
  grants: [
    // Rollover: what the month did not spend carries into the next one, at
    // most one month's worth, so `remaining` can pass `included`.
    // `cap` bills up to 10,000 units past `included` this period, then stops —
    // a ceiling in the feature's own unit, not in money.
    Paykit.allowance(Paykit.messages, {
      included: 10_000,
      overage: "bill",
      carryOver: true,
      cap: 2_000,
    }),
    Paykit.allowance(seats, { included: 10, overage: "block", resets: "never" }),
  ],
});

// An allowance that never runs out. Past it there is nothing to block or to
// bill, so `overage` defaults to "allow" and the catalog refuses any other.
const scale = Paykit.tier({
  id: "scale",
  name: "Scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [Paykit.allowance(Paykit.messages, { included: "unlimited" })],
});

// An on/off capability. A flag is declared once, then granted — not metered:
// `check()` answers allowed and there is no counter to spend or to reset.
const sso = Paykit.feature({ id: "sso", name: "SSO", kind: "flag" });

const enterprise = Paykit.tier({
  id: "enterprise",
  name: "Enterprise",
  price: { amount: 49_900, currency: "usd", interval: "month" },
  grants: [Paykit.grant(sso), Paykit.allowance(Paykit.messages, { included: 50_000 })],
});

// A feature priced in credits: a unit costs credits by the dimension that
// served it, and the tier grants the pool they are drawn from.
const ai = Paykit.feature({
  id: "ai",
  name: "AI",
  creditRates: { default: 1, "gpt-large": 10 },
});

const credits = Paykit.tier({
  id: "credits",
  name: "Credits",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  credits: 50_000, // granted on activation; `creditsExpire: "period"` is the default
  grants: [Paykit.allowance(Paykit.messages, { included: 50_000 })],
});

Paykit.catalog({
  features: [Paykit.messages, seats, sso, ai],
  tiers: [team, scale, enterprise, credits],
});
```

A feature is declared once and quoted by identity, so a tier cannot grant a feature the catalog
never declared. `catalog()` refuses duplicate feature ids, duplicate tier ids, a tier that grants
the same feature twice, a tier with no grants, an unlimited allowance that also names a `block` or
`bill` overage (`CatalogUnlimitedOverage`), a `kind: "flag"` feature granted a count
(`CatalogFlagNotGranted`), `carryOver` on a flag (`CatalogCarryOverOnFlag`) or beside
`resets: "never"` (`CatalogCarryOverNeverResets`), a rate card with no `"default"`
(`CatalogCreditRateMissing`), a rate that is not a positive integer (`CatalogCreditRateInvalid`), an
allowance for a credit-priced feature (`CatalogCreditFeatureHasAllowance`), a rate card on a flag
(`CatalogCreditAllowanceOnFlag`), an impossible credit grant (`CatalogCreditGrantInvalid`), a `cap`
where nothing is billed (`CatalogCapWithoutBilling`), a unit price where nothing is billed
(`CatalogUnitPriceWithoutBilling`), a money cap with no unit price
(`CatalogMoneyCapWithoutUnitPrice`), mixed unit-price currencies (`CatalogUnitPriceCurrency`), a
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
credit-priced feature reports the same `remaining`, `track({ feature, amount, dimension })` spends
`amount × rate` from it, and a request the pool cannot cover is refused with `CreditExceeded`.
`check({ feature, amount, dimension })` prices the request before comparing it, so it answers from
the same local read. A tier grants the pool with `credits`, and `creditsExpire: "period"` (the
default) zeroes it at a period close while `"never"` keeps it. A tier may also state `topUp`, the
credit line at or below which a spend buys the deployment's auto top-up pack; a one-off pack cannot
state one.

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

A deployment can also refill the pool itself. `autoTopUp({ catalog, pack })` provides a policy that
buys the named `kind: "one_off"` pack when a spend takes the pool from above the tier's `topUp` line
to at or below it: it asks the account's provider for the pack's price as an invoice keyed by the
crossing, and records the purchase with that invoice id. The line is catalog data on the tier and
rides the standing's events, so a free tier and an enterprise tier refill where their own grants run
low; a tier without one never refills. Only a spend crosses — a grant, an expiry or a hold
reservation does not — and one crossing buys one pack, so the next refill costs at least the pack's
credits in spending. A deployment that never provides the layer pays nothing for the policy.

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
| `Check()` | `{ allowed, remaining, resetsAt, standing }`, one local read (`remaining` is `null` when the allowance never runs out) |
| `Track()` | records a usage fact, deduped by key, atomically with its allowance check |
| `Subscribe()` | a hosted checkout URL, an invoice id, or `{ activated: true }` for a free tier |
| `Portal()` | the provider's customer portal, when it declares one |
| `Webhook()` | the webhook edge as a binding: `(event) => WebhookAction`, services resolved once |
| `handleWebhook(event)` | the same edge, reading the model from the context |

All money is `Schema.Int` minor units with a currency on every amount. A provider that does not
implement an optional op fails with `ProviderCapabilityMissing`; nothing degrades silently.

A `Hold` is an addressable reservation for work in flight: `Settle` bills what ran and returns the
rest in the same call, `Release` returns all of it, and a hold left open is released by `HoldSweep`
at its `expiresAt` (fifteen minutes by default). `reserved` on the read model is the fold of the
open holds, not a counter a command writes.

## Providers

| Provider | Kind | Required purchase path | Optional ops |
| --- | --- | --- | --- |
| `Paykit.Memory()` | memory | checkout + invoice | refund, portal, usage |
| `Paykit.Manual()` | manual | invoice | refund |
| `Paykit.Stripe({ bindings, tiers })` | processor | checkout | invoice, refund, portal, usage |
| `Paykit.PaymentsPolar({ bindings, tiers })` | merchant of record | checkout | refund, portal, usage |

`Polar` itself — the one-call provider — is [`@potion.run/paykit-polar`](../paykit-polar), and
`Stripe`'s is [`@potion.run/paykit-stripe`](../paykit-stripe). `PaymentsPolar` and `PaymentsStripe`
here are the port mappings those packages wrap, for a caller who brings its own bindings.

A Stack can run several providers. `Paykit.paymentsRouter(...)` holds them by name, and each call
resolves the provider the account's `refs` already name — falling back to the first — so an account
sold through one provider never gets upgraded through another. Names must be distinct.

`Manual` is the reference: if the port only fits Stripe, it is not a port. Every provider runs
the same conformance suite in [`test/conformance`](./test/conformance), parameterized by the
capabilities it declares.

The Stripe and Polar adapters take the bindings (`StripeBindings`, `PolarBindings`) a vendor
package supplies: `@potion.run/paykit-stripe` and `@potion.run/paykit-polar`. Those own HTTP, auth,
signatures and the webhook decoder; paykit owns the model.

Each vendor package also provisions its side of the catalog. `StripePrices` creates one product and
base price per priced tier, plus a billing meter and a metered price for every `usage` feature, and
returns `{ prices, usage, meters }`; `PolarPrices` creates one product per tier with its fixed and
metered prices, plus one meter per `usage` feature, and returns `{ products, meters }`. Hand the
`meters` map and the per-tier `usage` prices to `Stripe({ tiers, meters })` or `Polar({ tiers, meters })`
so the runtime can report the close. Both keep retired prices, products and meters in the vendor,
and neither lets a provider id into the catalog.

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
- The durable checkout saga (the checkout start/complete flow works today), scheduling a tier change
  withdrawal, and scheduled dunning retries beyond the grace deadline.

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

- [PLAN.md](./PLAN.md) — the design of record.
- [AGENTS.md](./AGENTS.md) — the rules for changing this package.
