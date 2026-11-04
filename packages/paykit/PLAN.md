# PLAN — `@potion.run/paykit`

A billing and entitlement library for Alchemy. You declare a catalog beside your stack,
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

It is a library, not a service. It runs inside the Worker that already holds your accounts,
next to your stack, against your database. There is no control plane to sign up for and no
second copy of your customers to reconcile.

## Non-goals

Tax calculation, invoice PDFs, SCA/3DS, being a merchant of record, refunds beyond a provider
call, email sending, revenue recognition, per-tenant sharding, and a hosted control plane. If
a feature needs a compliance officer, it is not in the package.

Three more, each a commitment rather than a backlog item:

- **No customer records.** The account id belongs to your app. Paykit never stores a name, an
  email or a profile, and never lists accounts it was not asked about by id.
- **No runtime catalog mutation.** A tier change is a deploy that `BillingStack` diffs. An API
  that edits a price at runtime has no version and no diff, so it is not in the model.
- **No multi-subscription per account.** One account, one standing. Allowance extensions are a
  command (`GrantCredits`, `ChangeTier`), not a second subscription. The single writer per
  account is what makes `Track` atomic, and it is not negotiable.

## Vocabulary

Fixed, and treated as API. Renaming one of these is a breaking change.

| Word | Means | Not to be called |
| --- | --- | --- |
| `Tier` | a purchasable bundle: `free`, `pro`, `scale` | `Plan` — collides with `alchemy/Plan` and `Backfill.Plan` |
| `Feature` | a meterable thing (`messages`, `seats`, `storage_gb`), or an on/off capability (`kind: "flag"`, e.g. `sso`) | `Meter` — this is not the provider's billing meter |
| `Allowance` | what a tier grants of one feature — a count or `"unlimited"` — and what happens past it | `Limit` — a limit is one field of an allowance |
| `Subscription` | one account's standing over time, keyed by account id | `Customer` — the provider owns customers |
| `Period` | `[start, end)` from the account's anchor and time zone | `BillingCycle` |
| `Usage` | append-only facts of consumption, deduped by key | `Counter` — a counter is a projection of these |
| `Reservation` | units held but not yet billed, for work in flight | `Lock` — a lock is a database primitive |
| `Standing` | `good \| grace \| blocked`, plus per-feature remaining | `Status` |
| `Actor` | who is calling: an `account`, an `admin`, or the `system` | `User`, `Principal` |

`Allowance.included` is a non-negative count or `"unlimited"`. `Allowance.overage` is one of
`"block"`, `"bill"`, `"allow"`, and is only meaningful for a count: an unlimited allowance
defaults it to `"allow"` and the catalog refuses any other value beside `"unlimited"`
(`CatalogUnlimitedOverage`). `Allowance.resets` is one of `"month"`, `"annual"`, `"never"`.

## Package

paykit is one package, not five. Resources, bindings, and the model ship together, because the
model is the product and splitting it makes users assemble our internals. The repo is a pnpm
workspace with two published packages — `packages/paykit` and `packages/paykit-polar` — plus
examples.

`packages/paykit/package.json` is the source of truth for the surface: it declares the four
export groups, the peers and the build output.

- `alchemy` and `effect` are required peers.
- `@alchemy.run/sql` is a dependency: the SQL store's migrations are Alchemy's migration
  registry (`@alchemy.run/sql/Migrations`), not a parallel implementation.
- `@alchemy.run/domain` is a dependency: the model is the product.
- `@alchemy.run/cloudflare`, `@potion.run/paykit-stripe`, `@potion.run/paykit-polar` and `foldkit`
  are optional peers plus dev dependencies, so a user who never imports `Polar` from
  `@potion.run/paykit-polar` never installs it.
- Versions come from the workspace catalog in `pnpm-workspace.yaml`; a package that needs a
  different line pins it locally and says why.

## Public surface

Four export groups, plus one opt-in entry point. Nothing else is exported.

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

yield* Paykit.Reserve({ account, feature: "messages", amount: 10, dedupeKey: turnId });
yield* Paykit.Settle({ account, feature: "messages", amount: 8 });
yield* Paykit.Release({ account, feature: "messages", amount: 2 });

const subscribe = yield* Paykit.Subscribe();
yield* subscribe({ account, tier: "pro" });                        // => { url } | { invoiceId } | { activated: true }

const portal = yield* Paykit.Portal();
const list = yield* Paykit.List();
yield* list({ standing: "grace", take: 100 });                     // => { rows, next }

const preview = yield* Paykit.Preview();
yield* preview({ account, command: { kind: "changeTier", tier: "scale" } });

const verify = yield* Paykit.Verify();
yield* verify({ account });                                        // => VerifyMismatch[]

// 3. model — embeddable, for apps that already own a Durable Object
Paykit.Model              // the Domain model, for `Story` tests and custom hosting
Paykit.BillingApi         // the tenant surface
Paykit.BillingAdminApi    // the ops console

// 4. providers
Paykit.Memory()  Paykit.Manual()  Paykit.Stripe()  Paykit.PaymentsPolar()

// and, from @potion.run/paykit-polar, the one-call form:
Polar({ accessToken, origin, tiers })

// opt-in: @potion.run/paykit/Surfaces — loads effect/ai and effect/cli
BillingMcp  BillingAdminMcp  BillingToolkit  BillingAdminToolkit  BillingCli
```

`Paykit.Stack` is a convenience, not a requirement. A user who already runs one Durable
Object per store hosts `Paykit.Model` inside it and provides the store layer themselves.
That duality is the point of building on a model framework rather than writing a service.

### Catalog authoring

A catalog is three plain declarations, and every value it holds is serializable:

- `feature({ id, name, kind })` declares a meter once. Its id is branded, so the id an allowance
  carries cannot be confused with an arbitrary string. `kind` is `"metered"` (the default) or
  `"flag"`, an on/off capability with no counter.
- `allowance(feature, { included, overage, resets })` quotes a declared feature in a tier, with
  `overage` defaulting to `block` for a count (and to `allow` for `"unlimited"`) and `resets` to
  `month`.
- `grant(feature)` grants a `"flag"` in a tier: `{ included: 1, overage: "allow", resets:
  "never" }`, which is how `decide` recognizes a flag from state alone. A flag granted any other
  way is refused.
- `tier({ id, name, price, grants })` bundles allowances. A tier with no `price` is free; a tier
  must grant at least one allowance, because one that grants nothing could never activate.
- `catalog({ features, tiers })` validates the whole thing and returns typed errors:
  `CatalogDuplicateFeature`, `CatalogDuplicateTier`, `CatalogDuplicateAllowance`,
  `CatalogUnknownFeature`, `CatalogEmptyTier`, `CatalogUnlimitedOverage`, `CatalogFlagNotGranted`,
  or `CatalogInvalid` for a schema failure.

Constructors stay pure and total. Validation happens at `catalog()`, which is where a deploy
can refuse a catalog before it reaches money. `defineCatalog()` is the synchronous `Result`
form for tooling and tests.

## Domain model

One aggregate, keyed by account. Subscription state, usage counters and open reservations live
together so a `TrackUsage` or a `ReserveUsage` that would exceed a blocking allowance is refused
in the same transaction that records it. Counters are always reproduced by folding events, so
they are a projection of the event log, not a second truth. `refs` is the only place a vendor
identifier may live: keyed by provider, so a second provider is additive, and unread by `decide`.

```ts
Subscription.aggregate   // id: account
state: {
  tier, status: "trialing" | "active" | "grace" | "canceled" | "expired",
  period: { start, end, anchorTz }, trialEndsAt?, graceUntil?,
  price?,                                   // what this account was sold at
  cancelAtPeriodEnd, credits,
  usage: { [feature]: number },             // billed, a fold of UsageRecorded
  reserved: { [feature]: number },          // held, a fold of the reservation events
  remaining: { [feature]: number | null },  // spendable now: included - usage - reserved; null when unbounded
  refs: { [provider]: { customer?, subscription?, checkout? } },  // opaque vendor ids
}
```

**`remaining` is the only number `check()` reads**, and it is already net of reservations. A
hold therefore refuses a second caller the unit the first one holds, without a second read path.

### Commands → events

| Command | Events | Rejections | Guard |
| --- | --- | --- | --- |
| `StartTrial` | `TrialStarted` | `TrialAlreadyUsed`, `TierNotInCatalog`, `CatalogMismatch` | `Session`, `CatalogGuard` |
| `Subscribe` | `SubscriptionActivated` | `TierNotInCatalog`, `CurrencyMismatch`, `CatalogMismatch` | `Session`, `CatalogGuard` |
| `ChangeTier` | `TierChanged` | `DowngradeBelowUsage`, `TierNotInCatalog`, `NotSubscribed`, `CurrencyMismatch`, `CatalogMismatch` | `Session`, `CatalogGuard` |
| `TrackUsage` | `UsageRecorded` | `AllowanceExceeded`, `StandingBlocksUsage`, `FeatureNotMetered` | `Session` |
| `ReserveUsage` | `UsageReserved` | `ReservationExceeded`, `StandingBlocksUsage`, `FeatureNotMetered` | `Session` |
| `SettleUsage` | `UsageRecorded`, `UsageSettled` | `NoReservation`, `StandingBlocksUsage`, `FeatureNotMetered` | `Session` |
| `ReleaseUsage` | `UsageReleased` | `NoReservation`, `FeatureNotMetered` | `Session` |
| `ConsumeCredits` | `CreditsConsumed` | `NotSubscribed`, `CreditExceedsBalance` | `Session` |
| `ScheduleCancellation` | `CancellationScheduled` | `AlreadyCanceled`, `NotSubscribed` | `Session` |
| `Resume` | `CancellationWithdrawn` | `NotScheduled`, `NotSubscribed` | `Session` |
| `RecordPayment` | `PaymentRecorded` | `NotInGrace` | `Admin` |
| `RecordPaymentFailure` | `PaymentFailed` | — | `Admin` |
| `EnterGrace` | `GraceEntered` | `AlreadyInGrace`, `NotSubscribed` | `Admin` |
| `Recover` | `Recovered` | `NotInGrace` | `Admin` |
| `Expire` | `SubscriptionExpired` | `NotInGrace` | `Admin` |
| `GrantCredits` | `CreditsGranted` | `NotSubscribed` | `Admin` |
| `ExtendTrial` | `TrialExtended` | `NotSubscribed`, `TrialNotActive` | `Admin` |
| `ClosePeriod` | `PeriodClosed`, `UsageReset`, `CreditsExpired` | `NotSubscribed`, `PeriodNotClosed` | — |
| `PeriodEnded` | `PeriodClosed`, `UsageReset`, `CreditsExpired` | — | — |
| `GraceElapsed` | `SubscriptionExpired` | — | — |
| `AttachProviderRef` | `ProviderRefAttached` | — | — |

`decide` is pure. It cannot read the clock, a provider or an ambient context, so authorization
lives in middleware rather than in `decide`. `ClosePeriod`, `PeriodEnded`, `GraceElapsed` and
`AttachProviderRef` carry no guard because a policy, a scheduler or a webhook translator sends
them as the deployment. `Proration` is a pure function in `src/Proration.ts` with its own
properties, and `evolve` copies the outcomes the events carry (`remainingAfter`,
`periodAfter`, `priceAfter`) instead of re-deriving a rule.

### The command carries its catalog fields

`Subscribe`, `ChangeTier` and `StartTrial` carry the `allowances` and the `price` they will record,
because `decide` is pure and cannot look them up. That leaves one hole: a caller who does not own the
catalog could omit the price, or claim allowances its tier does not grant, and write a standing that
can never be reconciled against an invoice.

`CatalogGuard` closes it. It reads the catalog the deployment validated and refuses a command whose
`tier`, `allowances` or `price` disagree, with `CatalogMismatch` naming the field, the expected value
and the actual one. It is a refusal, never a correction: silently rewriting a caller's input would
turn a client bug into a wrong invoice. Catalog-owning senders — `Paykit.Subscribe`, the webhook
translator — build the command from `CatalogService` and never see the guard.

### The model computes the proration; a binding collects it

`ChangeTier` carries its `proration`, and `decide` recomputes it with `prorate()` and refuses a
mismatch (`ProrationMismatch`), so the log records a number the model worked out. It does not
collect it: `decide` is pure, so the money moves in `ChargeProration`, which reads what the tier
change owed, opens one invoice through the `Payments` port, and records it with
`RecordProrationInvoice` → `ProrationInvoiced`.

Three rules make that safe to retry:

- **Only a positive `due` is charged.** A downgrade's credit is recorded and applied by the next
  period; paying money out is a refund, which is a provider action, not a subscription one.
- **Once.** The invoice id lives on the state, so a second call is `NoProrationDue { reason: "billed" }`
  rather than a second invoice, and the command id is the change itself so a retry after a crash
  records the same invoice.
- **The log carries the money.** A charge the events cannot reproduce is a charge nobody can audit,
  which is why it is a command with an event rather than a side effect of `changeTier`.
- **The page shows it.** `proration` and `prorationInvoice` are on `BillingState` and on
  `BillingReadRow`, so an operator sees what an upgrade cost and whether it was billed. A charge that
  only exists in the event log is a charge the console cannot show.

### Proration is computed by the model, not sent by the caller

A `ChangeTier` carries its `proration`, but the model does not trust it: `decide` calls `prorate()`
on the account's own prices and period and refuses a mismatch with `ProrationMismatch`. The event
records money, so a number a caller invented is a number nobody can audit. Moving that money is a
separate step, and needs a `Payments` operation the port does not have yet.

### Prices are logged, not looked up

`SubscriptionActivated` carries the `price` the account was sold at, and `TierChanged` carries
`priceBefore` and `priceAfter`. A catalog price change therefore never rewrites history: an
invoice can be reconciled against the log alone, and "what were we charging this account in
March" is one fold. A downgrade to a free tier records the absence of a price rather than
keeping the old one.

### Reads

| Kind | Name | Purpose |
| --- | --- | --- |
| View | `Entitlements` | per-feature `{ included, used, reserved, remaining, allowed, resetsAt, overage }` and standing — the `check()` read model, `allowed` being the judgement `check({ amount: 1 })` makes |
| View | `BillingState` | what a billing page shows: tier, price, period end, cancel-at-period-end, credits, `dunningAttempts`, and the last tier change's `proration` with the invoice it was billed on |
| Stream | `AccountEvents` | every event for one account, for the audit pane and support |
| Projection | `BillingRead` | SQL rows for `List`, dashboards and the edge read path |

Both views are guarded by `Session` and scoped by `validate`: an account reads only itself, an
admin reads any. A view folds one key's events, so cross-account dashboards come from the
`BillingRead` projection through `Paykit.List`, never from a view. Say so in the docs or the
first issue will be "how do I list past-due".

`Paykit.List` is a binding rather than an Api read because `Domain.Api` serves keyed reads.
`after` is a cursor, not an offset, so an account created or deleted between pages shifts no row.

### Processes

- `PeriodRollover` — a policy on the period start schedules `PeriodEnded`, which closes the
  period, resets usage and releases credits. `PeriodEnded` records nothing when the period is
  not over, so an early fire is a no-op rather than a rejection.
- `Dunning` — a policy on `PaymentFailed` schedules `GraceElapsed`, which expires only while the
  account is still in grace. A recovery before the deadline makes it a no-op.

  **Retries are the provider's.** Asking for the card to be charged again is a money-plane action
  and the port has no operation for it, so paykit records what happened — `attempt` on
  `PaymentFailed`, carried to `dunningAttempts` on both read models — and owns the grace window and
  the expiry. An operator sees the count on the billing page and decides whether to extend grace;
  the console is the reader, which is why the field is not write-only.
- Checkout is not a saga. `Subscribe` opens the provider's purchase path, stores its opaque
  reference with `AttachProviderRef`, and the provider's `payment_succeeded` or
  `checkout_completed` webhook activates the account. The provider event id is the command id,
  so a redelivery is a replay.

### External systems

```ts
Payments = Domain.ExternalSystem("Payments", {
  // required — a purchase path and a refund
  createCheckout: Op<{ account, tier }, { url }>,                    // hosted checkout
  createInvoice:  Op<{ account, amount, currency }, { invoiceId }>,  // when there is no hosted checkout
  refund:         Op<{ chargeId, amount }, {}>,
  // optional — declared per provider and surfaced as capabilities
  createPortal:   Op<{ account }, { url }>,
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
   (`Polar({ tiers: { pro: { price: proPrice, productId } } })`), so one catalog runs everywhere.
2. **Vendor identifiers live in `refs`,** keyed by provider. Nothing else in the model learns
   `cus_…`, `sub_…` or `prod_…`.
3. **A provider's entitlement view is a projection of ours, never the source.** Polar benefits
   and Stripe entitlements are written as a consequence of a tier change, where the provider
   has them; `check()` never reads them back.
4. **The price has one meaning.** The catalog states it, the vendor package charges it, and
   `Stack` refuses a mapping whose amount, currency or interval disagrees
   (`CatalogPriceMismatch`), so drift is a deploy error rather than a wrong invoice.

A Stack runs one or more providers: `paymentsRouter(...)` holds them in preference order, `refs`
stays keyed by provider, and a binding resolves the account's own provider before the fallback and
provides only that provider's layer. Two providers sharing a name are refused
(`ProviderDuplicate`), because `refs` could not tell them apart.

### The vendor package

A money provider is two layers. The **vendor package** declares the vendor's products, prices
and webhook endpoint as Alchemy resources, and exposes checkout, portal and refund as bindings
over its distilled SDK. paykit's adapter is a thin translation over those bindings: vendor HTTP,
auth and signature verification live in the vendor package, and the model imports neither.

Neither vendor has an Alchemy provider that does what paykit needs, so we publish both:
`@potion.run/paykit-stripe` and `@potion.run/paykit-polar` — paykit providers, not general Alchemy
ones: each imports paykit and exports the single call that stands the vendor up. It lives at
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
calls it. It is paykit-shaped on purpose — a general provider would need its own users, docs and
release train to justify the same maintenance, so `Polar(props)` in that package returns the
`Provider` the catalog needs and no bindings to wire. If the package slips, `PaymentsPolar` still
takes injected bindings, so a user can call `@distilled.cloud/polar` directly; no model or port
change.

## Surfaces

An Api is a selection of the model; HTTP, MCP and a CLI are protocols over that Api. One
declaration, four projections, no second place to keep them in step.

```ts
export class BillingApi extends Domain.Api("BillingApi", { model: PaykitModel, /* tenant */ }) {}

export class BillingAdminApi extends Domain.Api("BillingAdminApi", {
  model: PaykitModel,
  commands: ["GrantCredits", "ExtendTrial", "EnterGrace", "Recover", "Expire",
             "RecordPayment", "RecordPaymentFailure", "ScheduleCancellation", "Resume", "ChangeTier"],
  views: ["Entitlements", "BillingState"],
  streams: ["AccountEvents"],
  aggregates: ["Subscription"],
}) {}
```

| Projection | From | What it gives |
| --- | --- | --- |
| HTTP | `yield* BillingApi` | a Worker's `fetch`: commands and reads over Effect RPC, live reads over WebSockets |
| MCP | `DomainAi.toMcp(BillingApi)` | one tool per command and per non-stream read, through the Api's own middleware |
| CLI | `DomainCli.toCli(BillingAdminApi)` | one subcommand per served entry |
| Console | `Foldkit.make(BillingAdminApi)` | commands, failures and live snapshots |

`@potion.run/paykit/Surfaces` exports `BillingMcp`, `BillingAdminMcp`, `BillingToolkit`,
`BillingAdminToolkit` and `BillingCli`. It is a separate entry point so an app that serves only
HTTP never loads `effect/ai` or `effect/cli`.

Rules that keep the projections honest:

- **The Api is the unit of authorization.** MCP tools run through the Api's middleware using the
  MCP request's own headers, so the tenant MCP server authenticates exactly as the tenant HTTP
  surface does. Serve the two Apis at two paths; never merge them.
- **A tool is destructive unless it is a read.** `TrackUsage`, `ReserveUsage` and every other
  command is annotated `Destructive`; `Entitlements.get` is `Readonly`. A model that can write
  cannot be talked into thinking it is reading.
- **Streams are not tools.** `watch` and `events` are not one result, so they stay on the Api's
  own clients. An agent reads a snapshot, not a subscription.
- **Rejections are tool failures with `failureMode: "return"`.** A refusal is a result the model
  acts on, not a failed generation. Never a stack trace.
- **Preview before a write.** `Paykit.Preview` runs the same pure `decide` and reports the events
  and the proration a command would produce, so a console or an agent can show the charge first.
- **A query that spans accounts is a binding.** `Paykit.List` pages the projection. Do not add a
  command that writes nothing to get a list onto an Api.
- **A tool reads the answer, not the arithmetic.** `Entitlements` carries `allowed` per feature, the
  same judgement `check({ amount: 1 })` makes, so an agent reading the view does not re-derive it.
  A test asserts the two agree for every standing.
- **`@potion.run/paykit/Surfaces` is the only place a tool list lives.** It declares no behaviour: a
  change to a command shows up in the MCP tool list, the CLI and the console at once, and a test
  asserts the derivation rather than a hand-written list.

### Auth

`Session` and `Admin` are `RpcMiddleware` services. A command declares the weakest guard it
needs; the Api's composition of commands is the blast radius.

- `Session` resolves the `Actor` from the request and pins an `account` actor to its own account
  id. An `admin` or the `system` actor may act on any account. Views use the same guard plus a
  `validate` that re-checks the key, so a read is scoped even if a route forgot to be.
- `Admin` requires `kind === "admin"`. Granting credit, expiring a standing and replaying a
  charge declare it, so a tenant session cannot reach them at all.
- In-process senders (webhooks, policies, bindings) provide the actor themselves with
  `asSystem`. The deployment already authenticated the work.
- `CatalogGuard` is a third guard, on the three commands that carry catalog-derived fields. It
  provides nothing; it refuses a command whose allowances or price disagree with the catalog.
- `SessionFromHeaders` and `AdminFromHeaders` are development guards. They read
  `x-paykit-actor` and `x-paykit-kind`. A production deployment replaces them with a Layer over
  its own session, and the header never becomes an authentication scheme by accident.

`decide` stays pure: it does not read `Actor`, so a model rule never depends on which surface
sent a command. Authorization at the account boundary is middleware; a model rule about state
is `decide`.

## Storage

`Paykit.Postgres` and friends are a `Domain.Platform`, not a schema: model, views, policies and
sagas are identical on Postgres, SQLite/D1 and `Domain.InMemory`. `Domain.InMemory` stays green
as the others land — it is the proof the seam holds.

A store keeps all five `AggregateStore` guarantees or it is not a store: one writer per account
id, dedupe by `commandId`, atomic commit of events + state + receipt + deliveries, at-least-once
delivery in order, `schedule`/`tail` by notify or poll.

Two table classes, no more: `billing_event` (append-only, the only truth) and `billing_rm_*`
(rebuildable at any moment). A read model that becomes a source of truth is a bug.

- Every table is `billing_`-prefixed, the schema is configurable, `public` is never touched.
- Migrations are additive, forward-only SQL records applied through
  `@alchemy.run/sql/Migrations` — the same registry Alchemy uses. The registry owns the
  bookkeeping table (`billing_schema_version`), is name-keyed with content hashes, and refuses a
  rewritten or removed applied file. `migrate()` returns the ids it applied; a replay returns
  none. `migrateDryRun()` prints the DDL before anyone runs it against a money table.
- Postgres DDL qualifies every table with the configured schema; SQLite has no schemas. The
  migration executor sets `search_path` for the registry's unqualified bookkeeping queries and
  restores it afterwards, so it must be a dedicated session, not a pool that spreads statements.
- `paykit doctor` rebuilds every read model into temp tables and prints the event ids that
  disagree. A store ships when `doctor` is clean.
- Code or a test copied from Alchemy keeps a header with the upstream path and the
  catalog-pinned ref. Keep the copied shape 1:1 where it is a compatibility check; the mirrors
  under `.agent_sources/` and the catalog bump then make the next change a diff.

### Read paths for `check`

Preferred, in order: `CheckInProcess` (same Durable Object), `CheckReadModel` (one row from
`billing_rm_*` at the edge), `CheckHttp` (cross-service). Shipping only the HTTP one would
reintroduce the round trip the library exists to remove.

## Verify

`Paykit.Verify` judges one account's standing against the deploy and returns typed mismatches:

| Mismatch | Means |
| --- | --- |
| `MissingProviderRef` | a priced tier is in force but the account has no vendor reference, so the checkout never completed |
| `OrphanProviderRef` | a vendor reference outlived the standing it described |
| `TierHasNoPurchasePath` | the catalog sells a tier no configured provider can charge |

`verifyState` is the same judgement without a store, so `doctor` and a test can call it. This is
account-level drift. Vendor state that disagrees with ours needs a provider read, which is a
future `Payments` operation rather than something this function can see.

## Correctness bar

Every one of these fails on purpose before it passes.

1. Delivery permutations: any order, at most twice. State after any permutation equals state
   after the canonical order. This is the largest bug class in every system that accepts
   provider webhooks.
2. Replay determinism: folding an account's events reproduces its stored state for any
   generated command sequence.
3. Allowance: `used + reserved ≤ included` for `block`, never negative, and `remaining` is
   monotone within a period except at `ClosePeriod`, `ReserveUsage` and `ReleaseUsage`.
4. Proration: parts sum to the full price within rounding; credit plus charge nets to zero.
5. Idempotence: every command replayed with the same `commandId` produces no second event.
6. Cancellation and resume are idempotent; `Expire` from any state is terminal or a no-op.
7. Pricing: replaying the log reproduces every price the account was sold at, and a price change
   in the catalog never moves a standing that already exists.
8. Reservation: settle plus release never exceeds what was held, and `used` after a settle
   equals what was held — a hold is not billed twice.

Gates: `Domain.verify(Model)` returns empty, `Story` tests for every command and rejection,
the `Payments` conformance suite green for all implementations, money as `Schema.Int` minor
units with currency on every amount, no `Date.now()` inside `decide`, and a `TestClock` layer
in the test kit so a billing library can be time-travelled.

## Milestones

| # | Name | Ships | Exit criterion |
| --- | --- | --- | --- |
| M0 | Foundation | repo bootstrap, `Model`, `PaymentsMemory`, `Domain.InMemory` store, `Check` in-process | `Story` tests green, `Domain.verify` empty, CI runs |
| M1 | Durable truth | `layerSql` for Postgres and SQLite/D1, event log, receipts, outbox, `migrate`, `doctor` | kill -9 mid-command loses no event and produces no duplicate |
| M2 | Usage | `Track`, allowances, overage modes, reservations, period rollover by `schedule`, replay property | properties 2, 3, 5, 8 pass against generated sequences |
| M3 | Catalog and two providers | `Stack`, `tier`/`feature` resources, webhook endpoint, `PaymentsStripe`, `PaymentsPolar`, conformance suite | the same story passes on `Memory`, `Manual`, `Stripe` and `Polar`, and `packages/paykit/src/Subscription/` is untouched |
| M4 | Money paths | purchase path, payment events, grace, dunning, proration, cancel/resume, credits | property 1, 4 and 7 pass; a failed charge recovers without a second charge |
| M5 | Surfaces | `BillingApi`, `BillingAdminApi`, auth guards, `Surfaces` (MCP + CLI), `Preview`, `Verify`, `List`, foldkit console in `examples/` | an operator can answer "why is this account on pro" from the UI alone; an MCP client calling `BillingApi_TrackUsage_send` with an account header commits a real command and one without is refused |
| M6 | Release | docs, `alchemy dev` quickstart on `Memory`, versioning policy, `0.1.0` | a stranger bills in ten minutes with no provider key |

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
        index.ts                 # the four export groups and nothing else
        Surfaces.ts              # opt-in: MCP, toolkits, CLI
        Stack.ts                 # the resource that wires store + catalog + providers
        Feature.ts  Allowance.ts  Tier.ts  Catalog.ts  CatalogService.ts
        BillingStack.resource.ts
        Check.ts                 # in-process, read-model and HTTP read paths
        Track.ts  Hold.ts        # Reserve / Settle / Release
        Subscribe.ts  Portal.ts  List.ts  Preview.ts  Verify.ts  Webhooks.ts
        Proration.ts  Doctor.ts
        Auth/
          Actor.ts  Guards.ts  FromHeaders.ts
          Unauthenticated.rejection.ts  Forbidden.rejection.ts
        Subscription/
          Subscription.aggregate.ts  Subscription.state.ts  Subscription.id.ts
          <Command>.command.ts  <Rejection>.rejection.ts
          Entitlements.view.ts  BillingState.view.ts
          AccountEvents.stream.ts  BillingRead.projection.ts
          AccountEventsProjection.ts
          PeriodRollover.policy.ts  Dunning.policy.ts
        BillingApi.api.ts  BillingAdminApi.api.ts
        BillingReadStore.ts
        Payments.ts  PaymentsMemory.ts  PaymentsManual.ts
        PaymentsStripe.ts               # the port mapping @potion.run/paykit-stripe fills in
        PaymentsPolar.ts                # delegates to @potion.run/paykit-polar
        Store/Sql.ts  Store/SqlEventLog.ts  Store/Tables.ts
        Migrations/
      test/
        stories/  properties/  conformance/  providers/  sql/
        check/  preview/  list/  verify/  surfaces/  bindings/  subscribe/  webhooks/
    paykit-polar/                # @potion.run/paykit-polar — published separately
      package.json
      tsconfig.json
      tsconfig.test.json
      scripts/build.ts
      src/
      test/
  examples/
    billing/                     # a Worker that bills with MemoryStore + Manual, no provider key
    admin/                       # foldkit console
```

Model files use `<Noun>.<kind>.ts` from the domain conventions (`.aggregate`, `.command`,
`.rejection`, `.view`, `.stream`, `.projection`, `.policy`, `.api`); runtime files use Alchemy's
resource/binding pairing. Plain values keep plain names (`Feature.ts`, `Allowance.ts`,
`Tier.ts`, `Catalog.ts`). `packages/paykit/src/index.ts` re-exports the four groups and nothing
else. The root `pnpm typecheck` builds every package through project references, so a change in
`packages/paykit-polar` cannot land with a broken consumer.

## Known risks

- **Proration is unbounded.** Mid-cycle tier change, coupon, trial, partial refund, currency
  rounding. Timebox M4 and ship `ChangeTier` as `next period only` first; mid-cycle is a
  second pass with its own properties. `Preview` makes it visible before it is charged.
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
- **The Polar package is not a second product.** `@potion.run/paykit-polar` exists only to be
  paykit's Polar adapter, and it is allowed to import paykit for exactly that reason. Do not grow it
  a general-purpose surface: a Worker that sells a product without paykit is a *different* package,
  with its own name and its own users, and this one does not become it by accreting options.
- **Events are the API.** Event names and their fields are public. Version from 0.1.0 and keep
  `Backfill`/`CatchUp` so a projection change is a rebuild, not a rewrite.
- **A reservation that leaks shrinks an allowance.** `ReleaseUsage` refuses to release more than
  is held rather than clamping, so a leak surfaces as a typed error. Watch `reserved` in
  `BillingState` and alert on a hold older than its work.
- **An MCP tool can spend money.** The tool list is derived from the Api, so an Api that serves a
  priced command publishes a destructive tool. Keep `GrantCredits` off the tenant Api, and
  require a preview and a `commandId` before any write an agent may retry.
- **The SQL platform hosts the whole model on a real database.** All five `ModelHost` stores take
  the asynchronous executor — `SqlAggregateStore`, `SqlViewStore`, `SqlProjectionStore`,
  `SqlPolicyStore`, `SqlStreamStore` — and `test/sql/ModelOnSql.test.ts` hosts the real
  `PaykitModel` on SQLite, commits through the guarded path and reads `Entitlements` back out of
  `billing_rm_view_state`. Each of the five log guarantees has a test: dedupe by `commandId`, a
  restart sees only committed truth, one writer per account, a delivery stays in the outbox until
  accepted, a scheduled command survives a restart.

  An atomic unit is a port method, `atomic(effect)`, so both kinds of target are first class: SQLite
  holds one `BEGIN IMMEDIATE` open across the unit's reads and writes (`serializable`); D1 collects
  the unit's writes and commits them in one `batch` (`deferred`). `test/sql/Atomic.test.ts` proves
  both, including that a failed unit commits nothing.

  What is missing is the vendor side of the money plane, not the store. The example's Worker runs on
  a hosted database: `billingOnSql(d1)` builds the platform from the binding, `SqlBillingReadStore`
  puts the read models in the same schema, and `migrations/0001_init.sql` — generated from
  `migrationFiles` — is the DDL. `examples/billing/test/sql.test.ts` runs that same wiring over SQLite
  and asserts the event, the view row and the read-model page are rows in one database.
- **Stripe and Polar are both paykit-shaped packages.** `@potion.run/paykit-stripe` and
  `@potion.run/paykit-polar` each build a client on their distilled SDK and return the provider the
  catalog needs, so a deployment writes one call and no bindings. `PaymentsStripe` and
  `PaymentsPolar` are the port mappings underneath, for a test or a caller with its own bindings.
- **Polar has no Alchemy package, so paykit publishes one — and it is paykit-shaped.**
  `Polar(props)` in `@potion.run/paykit-polar` returns the `Provider` the catalog needs, so a user
  writes one call and no bindings. It imports `@potion.run/paykit` on purpose: a general Alchemy
  provider would need its own users, docs and release train, and we would carry all of it to serve
  one adapter. Stripe without paykit, if anyone wants it, is `@alchemy.run/stripe`.
- **A missing capability is not a fabricated decline.** A client that cannot refund declares no
  `refund` capability, and asking for one fails with `ProviderCapabilityMissing`. Nothing pretends
  a card was declined.
- **A catalog-derived command needs the catalog.** `Subscribe`, `ChangeTier` and `StartTrial` carry
  their own allowances and price. `CatalogGuard` refuses a mismatch, but it cannot invent a missing
  price, so an Api client must send the fields the catalog implies. `tierCommand()` in the example is
  the shape to copy; a generated client would be better.
