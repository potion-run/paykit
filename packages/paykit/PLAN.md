# PLAN — `@potion.run/paykit`

A billing and entitlement library for Alchemy. You declare a catalog next to your stack,
the library keeps each account's **standing** and answers `check()` at request time, and the
provider you plug in owns the money plane — never the entitlement one.

Package name: `@potion.run/paykit`. Namespace in code: `Paykit`. No unscoped release.

## What this is

Two planes, deliberately separated:

- **Entitlement plane** (ours): is this account allowed to do this, right now, how much is
  left, and when does it reset. Answerable in one local read, no provider round trip.
- **Money plane** (the provider's): checkout, cards, tax, invoices, receipts, retries that
  chase a card. Ours only as a port with implementations.

A subscription is not a payment. A payment is an event that changes a standing. Everything
this library owns is derived from that sentence.

## Non-goals

Tax calculation, invoice PDFs, SCA/3DS, being a merchant of record, refunds beyond a provider
call, email sending, revenue recognition, per-tenant sharding, and a hosted control plane. If
a feature needs a compliance officer, it is not in the package.

## Vocabulary

Fixed, and treated as API. Renaming one of these is a breaking change.

| Word | Means | Not to be called |
| --- | --- | --- |
| `Tier` | a purchasable bundle: `free`, `pro`, `scale` | `Plan` — collides with `alchemy/Plan` and `Backfill.Plan` |
| `Feature` | a meterable thing: `messages`, `seats`, `storage_gb` | `Meter` — this is not the provider's billing meter |
| `Allowance` | what a tier grants of one feature, and what happens past it | `Limit` — a limit is one field of an allowance |
| `Subscription` | one account's standing over time, keyed by account id | `Customer` — the provider owns customers |
| `Period` | `[start, end)` from the account's anchor and time zone | `BillingCycle` |
| `Usage` | append-only facts of consumption, deduped by key | `Counter` — a counter is a projection of these |
| `Standing` | `good \| grace \| blocked`, plus per-feature remaining | `Status` |

`Allowance.overage` is one of `"block"`, `"bill"`, `"allow"`. `Allowance.resets` is one of
`"month"`, `"annual"`, `"never"`.

## Package

paykit is one package, not five. Resources, bindings, and the model ship together, because the
model is the product and splitting it makes users assemble our internals. The repo is a pnpm
workspace with two published packages — `packages/paykit` and `packages/paykit-polar` — plus
examples.

`packages/paykit/package.json` is the source of truth for the surface: it declares the four
export groups, the peers and the build output.

- `alchemy` and `effect` are required peers.
- `@alchemy.run/cloudflare`, `@alchemy.run/sql`, `@alchemy.run/stripe`,
  `@potion.run/paykit-polar` and `foldkit` are optional peers plus dev dependencies, so a user
  who never imports `Paykit.Polar()` never installs `@potion.run/paykit-polar`.
- `@alchemy.run/domain` is a dependency: the model is the product.
- Versions come from the workspace catalog in `pnpm-workspace.yaml`; a package that needs a
  different line pins it locally and says why.

## Public surface

Four export groups. Nothing else is exported.

```ts
// 1. deploy-time — resources with Diff / Read / Reconcile / Delete
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

const billing = yield* Paykit.Stack("Billing", {
  store: Paykit.Postgres({ url: Config.Redacted("DATABASE_URL"), schema: "billing" }),
  providers: [Paykit.Stripe()],
  catalog: { features: [messages], tiers: [free, pro] },
});

// 2. runtime — Binding.Services, one contract each, several implementations
const check = yield* Paykit.Check();
yield* check({ account, feature: "messages", amount: 1 });        // => { allowed, remaining, resetsAt, standing }

const track = yield* Paykit.Track();
yield* track({ account, feature: "messages", amount: 1, dedupeKey: requestId });

const subscribe = yield* Paykit.Subscribe();
yield* subscribe({ account, tier: "pro" });                        // => { url } | { invoiceId }

const portal = yield* Paykit.Portal();

yield* Paykit.consumeEvents("BillingEvents",
  { events: [Paykit.TierChanged, Paykit.PaymentFailed] },
  Effect.fn(function* (event) { /* our events, never the provider's */ }));

// 3. model — embeddable, for apps that already own a Durable Object
Paykit.Model            // the Domain model, for `Story` tests and custom hosting
Paykit.BillingAdminApi  // for the ops console

// 4. providers
Paykit.Memory()  Paykit.Manual()  Paykit.Stripe()  Paykit.Polar()
```

`Paykit.Stack` is a convenience, not a requirement. A user who already runs one Durable
Object per store hosts `Paykit.Model` inside it and provides the store layer themselves.
That duality is the point of building on a model framework rather than writing a service.

### Catalog authoring

A catalog is three plain declarations, and every value it holds is serializable:

- `feature({ id, name })` declares a meter once. Its id is branded, so the id an allowance
  carries cannot be confused with an arbitrary string.
- `allowance(feature, { included, overage, resets })` quotes a declared feature in a tier, with
  `overage` defaulting to `block` and `resets` to `month`.
- `tier({ id, name, price, grants })` bundles allowances. A tier with no `price` is free; a tier
  must grant at least one allowance, because one that grants nothing could never activate.
- `catalog({ features, tiers })` validates the whole thing and returns typed errors:
  `CatalogDuplicateFeature`, `CatalogDuplicateTier`, `CatalogDuplicateAllowance`,
  `CatalogUnknownFeature`, `CatalogEmptyTier`, or `CatalogInvalid` for a schema failure.

Constructors stay pure and total. Validation happens at `catalog()`, which is where a deploy
can refuse a catalog before it reaches money. `defineCatalog()` is the synchronous `Result`
form for tooling and tests.

## Domain model

One aggregate, keyed by account. Subscription state and usage counters live together so a
`Track` that would exceed a blocking allowance is refused in the same transaction that
records it. Counters are always reproduced by folding events, so they are a projection of
the event log, not a second truth. `refs` is the only place a vendor identifier may live:
keyed by provider, so a second provider is additive, and unread by `decide`.

```ts
Subscription.aggregate   // id: account
state: {
  tier, status: "trialing" | "active" | "grace" | "canceled" | "expired",
  period: { start, end, anchorTz }, trialEndsAt?, graceUntil?,
  cancelAtPeriodEnd, credits, usage: { [feature]: number },
  refs: { [provider]: { customer?, subscription?, checkout? } },  // opaque vendor ids
}
```

### Commands → events

| Command | Events | Rejections |
| --- | --- | --- |
| `StartTrial` | `TrialStarted` | `TrialAlreadyUsed`, `TierNotInCatalog` |
| `Subscribe` | `SubscriptionActivated` | `TierNotInCatalog`, `CurrencyMismatch` |
| `ChangeTier` | `TierChanged` (carries proration) | `DowngradeBelowUsage`, `TierNotInCatalog` |
| `TrackUsage` | `UsageRecorded` | `AllowanceExceeded`, `StandingBlocksUsage` |
| `RecordPayment` | `PaymentRecorded` | `NotInGrace` |
| `RecordPaymentFailure` | `PaymentFailed` | — |
| `EnterGrace` | `GraceEntered` | `AlreadyInGrace` |
| `Recover` | `Recovered` | `NotInGrace` |
| `GrantCredits` | `CreditsGranted` | — |
| `ConsumeCredits` | `CreditsConsumed` | `CreditExceedsBalance` |
| `ScheduleCancellation` | `CancellationScheduled` | `AlreadyCanceled` |
| `Resume` | `CancellationWithdrawn` | `NotScheduled` |
| `ClosePeriod` | `PeriodClosed`, `UsageReset`, `CreditsExpired` | `PeriodNotClosed` |
| `Expire` | `SubscriptionExpired` | `NotInGrace` |

`decide` is pure. Proration is a pure function in `src/Proration.ts` with its own properties.
`evolve` copies outcomes the events carry (`remainingAfter`, `periodAfter`) instead of
re-deriving a rule.

### Reads

| Kind | Name | Purpose |
| --- | --- | --- |
| View | `Entitlements` | per-feature `{ included, used, remaining, resetsAt, overage }` and standing — the `check()` read model |
| View | `BillingState` | what a billing page shows: tier, period end, cancel-at-period-end, credits |
| Stream | `AccountEvents` | every event for one account, for the audit pane and support |
| Projection | `BillingRead` | SQL rows for `list`, dashboards and the edge read path |

A view folds one key's events, so cross-account dashboards are the `BillingRead` projection,
never a view. Say so in the docs or the first issue will be "how do I list past-due".

### Processes

- `Checkout.saga` — create the provider session, wait for `PaymentRecorded`, activate, grant
  intro credits. Started by a policy on `Subscribe`.
- `Dunning.saga` — retry schedule, grace window, downgrade, expire. Started by a policy on
  `PaymentFailed`. Steps are keyed by account, so a replayed start does not double-charge.
- `TierChange.saga` — proration charge, apply at the boundary, undo if the charge fails.

Policies: `PaymentFailed → Dunning`, `GraceElapsed → Expire`, `PeriodEnded → ClosePeriod`,
`CreditsGranted → ...` nothing; credits need no notification to be correct.

### External systems

```ts
Payments = Domain.ExternalSystem("Payments", {
  // required — a purchase path and a refund
  createCheckout: Op<{ account, tier }, { url }>,                    // hosted checkout
  createInvoice:  Op<{ account, amount, currency }, { invoiceId }>,  // when there is no hosted checkout
  refund:         Op<{ chargeId, amount }, {}>,
  // optional — declared per provider and surfaced as capabilities
  createPortal:   Op<{ account }, { url }>,
  syncTier:       Op<{ account, tier }, {}>,
});
```

Implementations: `PaymentsMemory`, `PaymentsManual` (invoice payable by transfer or cash —
the honest first provider), `PaymentsStripe`, `PaymentsPolar`. Every implementation passes one
conformance suite, parameterized by the capabilities it declares; that is how `Manual` proves
each real provider is a port and not a special case.

Two provider kinds, one port. **Processors** (Stripe) move money; **merchants of record**
(Polar, Paddle, Lemon Squeezy) also own tax, receipts and the customer portal. The required
surface is what every provider can do anyway — sell through one purchase path (hosted checkout
or invoice) and refund — and each provider declares the optional ops it adds.
`Paykit.<Provider>()` returns `{ kind, ops, payments }`; `Stack` checks the ops the catalog
implies (a priced tier needs a purchase path) and exposes the rest as attributes. A binding
that needs an absent op fails with `ProviderCapabilityMissing` — no silent degradation.

Four rules keep the port from re-forming around whichever provider shipped first:

1. **The catalog carries no provider ids.** Tier → price mapping lives in the provider config
   (`Paykit.Polar({ tiers: { pro: proPrice } })`), so one catalog runs everywhere.
2. **Vendor identifiers live in `refs`,** keyed by provider. Nothing else in the model learns
   `cus_…`, `sub_…` or `prod_…`.
3. **A provider's entitlement view is a projection of ours, never the source.** Polar benefits
   and Stripe entitlements are written as a consequence of a tier change, where the provider
   has them; `check()` never reads them back.
4. **The price has one meaning.** The catalog states it, the vendor package charges it, and
   `Stack` refuses a mapping whose amount, currency or interval disagrees
   (`CatalogPriceMismatch`), so drift is a deploy error rather than a wrong invoice.

`0.1` runs one provider per Stack, and `refs` is already keyed by provider, so two is additive.

### The vendor package

A money provider is two layers. The **vendor package** declares the vendor's products, prices
and webhook endpoint as Alchemy resources, and exposes checkout, portal and refund as bindings
over its distilled SDK. paykit's adapter is a thin translation over those bindings: vendor HTTP,
auth and signature verification live in the vendor package, and the model imports neither.

Stripe uses Alchemy's `@alchemy.run/stripe`. Polar has no such package, so we publish
`@potion.run/paykit-polar` — a general Polar provider for Alchemy, not a paykit SDK. It lives at
`packages/paykit-polar/` in this workspace, versioned and published on its own, and paykit takes
it as an optional peer plus a `workspace:*` dev dependency. Its `package.json` mirrors Alchemy's
`packages/stripe`: `alchemy` and `effect` as peers, `@distilled.cloud/polar` as a dependency.

The minimum surface paykit consumes:

| Kind | Exports |
| --- | --- |
| Resources | `Product` with its prices, `WebhookEndpoint` |
| Bindings | `CreateCheckoutSession`, `CreateCustomerSession`, `CreateRefund`, `ConsumeEvents` |

Stripe models a price as its own resource; Polar embeds prices in the product. That difference
stops at the vendor package — paykit's config maps a tier to a price handle, whatever the vendor
calls it. `@potion.run/paykit-polar` must be usable with no paykit import: its README is a Worker
that sells a product, its tests are live Polar tests, and paykit-specific helpers never land in
it. If the package slips, `PaymentsPolar` calls `@distilled.cloud/polar` directly; no model or
port change.

## Storage

`Paykit.Postgres` and friends are not schemas. They are a second `Domain.Platform`, which is
the framework's own swap point: the model, views, policies and sagas are unchanged, and
`Domain.InMemory` is proof the seam holds.

The store must preserve the whole `AggregateStore` contract:

| Guarantee | Postgres | SQLite / D1 |
| --- | --- | --- |
| single writer per id | `pg_advisory_xact_lock(hashtext($id))` first in the txn | `BEGIN IMMEDIATE` |
| dedupe by `commandId` | unique index `(aggregate, id, command_id)` | same |
| atomic commit | one txn: events, state, receipt, deliveries | one txn |
| at-least-once, in order | outbox + drain | same |
| `tail` / `changes` | `LISTEN/NOTIFY`, else `seq > after` poll | poll |
| `schedule` / `unschedule` | `billing_due` + poller | same |

Advisory locks are what make "your database is the ledger" true rather than aspirational:
they restore per-account serialization inside the user's own Postgres.

### Schema rules

- Every table is `billing_`-prefixed; the schema is configurable; `public` is never touched.
- Exactly two table classes: `billing_event` (append-only, the only truth) and `billing_rm_*`
  (read models, rebuildable at any moment). A read model that becomes a source of truth is
  a bug, not a cache to invalidate.
- Migrations are `SqlFile`s run through `@alchemy.run/sql/Migrations`, additive and
  forward-only, with a `billing_schema_version` row. `paykit migrate --dry-run` prints the
  SQL; nobody runs library DDL against a money table blind.
- `paykit doctor` rebuilds every read model into temp tables, diffs, and prints the event ids
  that disagree. That command is what earns the right to touch someone's database.

### Read paths for `check`

Preferred, in order: `CheckInProcess` (same Durable Object), `CheckReadModel` (one row from
`billing_rm_*` at the edge), `CheckHttp` (cross-service). Shipping only the HTTP one would
reintroduce the round trip the library exists to remove.

## Admin surface

Two Apis over one model, different middleware, different blast radius:

```ts
export class BillingApi extends Domain.Api("BillingApi", { model: Paykit, /* tenant surface */ }) {}

export class BillingAdminApi extends Domain.Api("BillingAdminApi", {
  model: Paykit,
  commands: ["GrantCredits", "ExtendTrial", "ScheduleCancellation", "Resume", "RetryDunning", "ChangeTier"],
  views: ["Entitlements", "BillingState"],
  streams: ["AccountEvents"],
  aggregates: ["Subscription"],
}) {}
```

`Foldkit.make(BillingAdminApi)` derives everything the console needs: one `Command` per
command with a `commandId` and a typed `reply`; a `Failure` union of `Rejected | Denied |
Unknown`, where `Unknown` is exactly the retry-with-the-same-id case, so a double click
cannot double-credit. `<Read>.watch({ key, isEnabled, toMessage, onFailure, onDefect })`
gives live snapshots with `Option` absence and a cursor that does not restart the stream.
`SnapshotFlags` hydrates the first frame from flags.

Lists and metrics come from `Subscription.list({ where, order, take, after })`. On the SQL
platform that is one indexed query; on a sharded Durable Object platform it is a fan-out, so
`BillingRead` serves it. The audit pane tails `AccountEvents` and renders every computed
number next to the events that produced it, because an operator who cannot audit a number
will export to a spreadsheet instead.

## Correctness bar

Every one of these fails on purpose before it passes.

1. Delivery permutations: any order, at most twice. State after any permutation equals state
   after the canonical order. This is the largest bug class in every system that accepts
   provider webhooks.
2. Replay determinism: folding an account's events reproduces its stored state for any
   generated command sequence.
3. Allowance: `used ≤ included` for `block`, never negative, and `remaining` is monotone
   within a period except at `ClosePeriod`.
4. Proration: parts sum to the full price within rounding; credit plus charge nets to zero.
5. Idempotence: every command replayed with the same `commandId` produces no second event.
6. Cancellation and resume are idempotent; `Expire` from any state is terminal or a no-op.

Gates: `Domain.verify(Model)` returns empty, `Story` tests for every command and rejection,
the `Payments` conformance suite green for all implementations, money as `Schema.Int` minor
units with currency on every amount, no `Date.now()` inside `decide`, and a `TestClock` layer
in the test kit so a billing library can be time-travelled.

## Milestones

| # | Name | Ships | Exit criterion |
| --- | --- | --- | --- |
| M0 | Foundation | repo bootstrap, `Model`, `PaymentsMemory`, `Domain.InMemory` store, `Check` in-process | `Story` tests green, `Domain.verify` empty, CI runs |
| M1 | Durable truth | `layerSql` for Postgres and SQLite/D1, event log, receipts, outbox, `migrate`, `doctor` | kill -9 mid-command loses no event and produces no duplicate |
| M2 | Usage | `Track`, allowances, overage modes, period rollover by `schedule`, replay property | properties 2, 3, 5 pass against generated sequences |
| M3 | Catalog and two providers | `Stack`, `tier`/`feature` resources, webhook endpoint, `PaymentsStripe`, `PaymentsPolar`, conformance suite | the same story passes on `Memory`, `Manual`, `Stripe` and `Polar`, and `packages/paykit/src/Subscription/` is untouched |
| M4 | Money paths | checkout saga, payment events, grace, dunning, proration, cancel/resume, credits | property 1 and 4 pass; a failed charge recovers without a second charge |
| M5 | Admin | `BillingAdminApi`, foldkit console in `examples/`, audit pane, lists | an operator can answer "why is this account on pro" from the UI alone |
| M6 | Release | docs, `alchemy dev` quickstart on `Memory`, versioning policy, `0.1.0` | a stranger bills in ten minutes with no provider key |

M3 depends on `@potion.run/paykit-polar` (see [The vendor package](#the-vendor-package)). It ships
from `packages/paykit-polar` on its own version line; its live tests are the gate, and paykit
consumes it as a peer.

Roughly nine weeks of focused work. M4 is where the estimate goes wrong; proration and
dunning are the two things nobody gets right the first time.

## Repo layout

A pnpm workspace, like the Alchemy repo: published packages under `packages/`, runnable apps
under `examples/`. paykit keeps properties and stories side by side; `@potion.run/paykit-polar`
is a general Alchemy provider and knows nothing about paykit.

```
potion/                          # pnpm workspace root (private)
  package.json                   # scripts only: typecheck, lint, format, test, build
  pnpm-workspace.yaml            # packages: [packages/*, examples/*], catalog + task graph
  tsconfig.json                  # project references to every package
  tsconfig.base.json             # compiler options every package extends
  oxlint.config.ts               # type-aware lint rules
  oxfmt.config.ts                # formatting
  scripts/build-package.ts       # `build:package` for every package
  .husky/pre-commit              # formats staged files
  packages/
    paykit/                      # @potion.run/paykit
      package.json
      tsconfig.json              # emits ./lib
      tsconfig.test.json         # type-checks ./test, no emit
      scripts/build.ts
      src/
        index.ts
        Stack.ts                    # the resource that wires store + catalog + providers
        Feature.ts  Allowance.ts  Tier.ts  Catalog.ts
        Check.ts  CheckInProcess.ts  CheckReadModel.ts  CheckHttp.ts
        Track.ts  TrackBinding.ts
        Subscribe.ts  Portal.ts
        Proration.ts
        Subscription/
          Subscription.aggregate.ts
          Subscription.id.ts
          ChangeTier.command.ts
          TrackUsage.command.ts
          AllowanceExceeded.rejection.ts
          Entitlements.view.ts
          BillingState.view.ts
          AccountEvents.stream.ts
          BillingRead.projection.ts
          Dunning.saga.ts
          Checkout.saga.ts
        Payments.ts  PaymentsMemory.ts  PaymentsManual.ts
        PaymentsStripe.ts               # delegates to @alchemy.run/stripe
        PaymentsPolar.ts                # delegates to @potion.run/paykit-polar
        BillingAdminApi.api.ts
        Store/Postgres.ts  Store/Sqlite.ts  Store/DurableObjects.ts
        Migrations/
      test/
        toolchain.test.ts               # delete when the first real suite lands
        properties/  stories/  conformance/
    paykit-polar/                # @potion.run/paykit-polar — published separately
      package.json
      tsconfig.json
      tsconfig.test.json
      scripts/build.ts
      src/
      test/
  examples/
    admin/                       # foldkit console
```

Model files use `<Noun>.<kind>.ts` from the domain conventions; runtime files use Alchemy's
resource/binding pairing. `packages/paykit/src/index.ts` re-exports the four groups and nothing
else. The root `pnpm typecheck` builds every package through project references, so a change in
`packages/paykit-polar` cannot land with a broken consumer.

## Known risks

- **Proration is unbounded.** Mid-cycle tier change, coupon, trial, partial refund, currency
  rounding. Timebox M4 and ship `ChangeTier` as `next period only` first; mid-cycle is a
  second pass with its own properties.
- **Two stores is double the work.** The SQL store is the expensive half of the library.
  Build it second, after M2 proves the model against `Domain.InMemory`.
- **Deletion has to respect money.** `RemovalPolicy.RETAIN` on catalog and account resources,
  and say in the README that the ledger is application data, not stack state. A `destroy`
  that cancels a live subscription is a support incident.
- **Provider vocabulary leaks.** Modeling checkout as an event we own, not a provider call we
  forward, is what keeps `Manual` possible. Every "just read it from the provider" is a
  future migration. The test is concrete: adding a provider touches its vendor package,
  `Payments<V>.ts`, the provider config and the conformance suite — never `Subscription/*`.
- **The provider's entitlement API is a decoy.** Polar ships benefits and Stripe ships
  entitlements; both look like the read model this library exists to own. Reading either back
  makes the provider the truth and reintroduces the round trip. They are written outputs, never
  inputs.
- **The vendor package is a second product.** `@potion.run/paykit-polar` has its own users, docs
  and release train, and we maintain it. It must stand alone — the moment a paykit-shaped helper
  lands in it, the port has leaked backwards. The conformance suite is still the drift alarm
  between the two version lines.
- **Events outlive the library.** Event names and their fields are the public API. Version
  from 0.1.0 and expose `Backfill`/`CatchUp` so a projection change is a rebuild, not a
  rewrite.
