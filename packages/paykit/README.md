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

const billing = yield* Paykit.Stack("Billing", {
  store: Paykit.MemoryStore(),
  providers: [Paykit.Memory()],
  catalog: { features: [messages], tiers: [free, pro] },
});

// An in-process host for tests and `alchemy dev`.
const ModelWorld = Paykit.Model.layer(Paykit.PaykitHandlers)
  .pipe(Layer.provideMerge(Paykit.MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory));
const World = Layer.mergeAll(ModelWorld, Paykit.catalogLayer(billing.catalog));

yield* Effect.gen(function* () {
  const subscribe = yield* Paykit.Subscribe();
  const track = yield* Paykit.Track();
  const check = yield* Paykit.Check();

  yield* subscribe({ account: "acct_1", tier: "free" });
  yield* track({ account: "acct_1", feature: "messages", amount: 1, dedupeKey: "req_1" });

  const answer = yield* check({ account: "acct_1", feature: "messages", amount: 1 });
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
    Paykit.allowance(Paykit.messages, { included: 10_000, overage: "bill" }),
    Paykit.allowance(seats, { included: 10, overage: "block", resets: "never" }),
  ],
});

Paykit.catalog({ features: [Paykit.messages, seats], tiers: [team] });
```

A feature is declared once and quoted by identity, so a tier cannot grant a feature the catalog
never declared. `catalog()` refuses duplicate feature ids, duplicate tier ids, a tier that grants
the same feature twice, a tier with no grants, and a price that is not positive whole minor units.

The catalog carries no provider ids. A provider maps tiers to its own handles, and `Stack`
refuses a mapping whose amount, currency or interval disagrees with the catalog
(`CatalogPriceMismatch`).

## Runtime

| Binding | Answers |
| --- | --- |
| `Check()` | `{ allowed, remaining, resetsAt, standing }`, one local read |
| `Track()` | records a usage fact, deduped by key, atomically with its allowance check |
| `Subscribe()` | a hosted checkout URL, an invoice id, or `{ activated: true }` for a free tier |
| `Portal()` | the provider's customer portal, when it declares one |

All money is `Schema.Int` minor units with a currency on every amount. A provider that does not
implement an optional op fails with `ProviderCapabilityMissing`; nothing degrades silently.

## Providers

| Provider | Kind | Required purchase path | Optional ops |
| --- | --- | --- | --- |
| `Paykit.Memory()` | memory | checkout + invoice | refund, portal, syncTier |
| `Paykit.Manual()` | manual | invoice | refund |
| `Paykit.Stripe({ bindings, tiers })` | processor | checkout | invoice, refund, portal, syncTier |
| `Paykit.PaymentsPolar({ bindings, tiers })` | merchant of record | checkout | refund, portal, syncTier |

`Polar` itself — the one-call provider — is [`@potion.run/paykit-polar`](../paykit-polar), and
`Stripe`'s is [`@potion.run/paykit-stripe`](../paykit-stripe). `PaymentsPolar` and `PaymentsStripe`
here are the port mappings those packages wrap, for a caller who brings its own bindings.

One provider per Stack. `Payments` is a single service, so a second provider would answer the same port and win by layer order, silently; `Stack` refuses it with `ProviderAmbiguous` instead.

`Manual` is the reference: if the port only fits Stripe, it is not a port. Every provider runs
the same conformance suite in [`test/conformance`](./test/conformance), parameterized by the
capabilities it declares.

The Stripe and Polar adapters take the vendor bindings (`StripeBindings`, `PolarBindings`) that
`@alchemy.run/stripe` and `@potion.run/paykit-polar` expose. The vendored packages own HTTP, auth
and signature verification; paykit owns the model.

## The model

One aggregate keyed by account holds both the standing and its usage counters. A view folds one
account's events; lists and dashboards come from the `BillingRead` projection, never from a view.

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
- M2 usage: allowances, overage modes, dedupe, scheduled period rollover and reset, replay and
  allowance properties.
- M3 catalog and adapter shape: `Stack` validation, `Manual` reference provider, Stripe/Polar
  adapters over their bindings, one conformance suite, the `BillingStack` resource with a
  retain default, and the provider webhook edge (provider event id as the command id).
- M4 money commands: checkout start/complete, payments, grace, scheduled grace expiry
  (dunning), credits, proration property, cancellation and resume.
- M5 admin and reads: `BillingAdminApi`, the `AccountEvents` stream, the `BillingRead`
  projection, and the three `Check` read paths (in-process, read model, HTTP transport).
- M1 first half: the SQL event log with receipts, outbox, schedule and per-account locking,
  migrations through `@alchemy.run/sql/Migrations` (content hashes, drift detection, custom
  schema, dry-run DDL), and `doctor` rebuilding the read model and naming the event ids that
  disagree.

Not shipped yet, and deliberately not faked:

- The full SQL `Domain.Platform` (`ModelHost`, views/policies/projections, backfill). The
  event-log core, migrations and `doctor` exist and are tested; Postgres/D1 driver adapters and
  wiring the model onto them are next.
- A `paykit migrate` / `paykit doctor` CLI; the library effects (`migrate`, `migrateDryRun`,
  `doctor`) are ready for it.
- The durable checkout saga (the checkout start/complete flow works today), mid-cycle
  proration charges, and scheduled dunning retries beyond the grace deadline.
- A real `@potion.run/paykit-polar` vendor package (currently scaffolding) and the foldkit
  console in `examples/`.

## Test layout

| Suite | Proves |
| --- | --- |
| `test/stories` | every command's happy path and every rejection |
| `test/properties` | proration, allowances, replay and idempotence |
| `test/conformance` | every `Payments` implementation passes the cases its capabilities declare |
| `test/sql` | the event log's transaction, dedupe and read-model contract, plus migration apply, drift and dry-run |
| `test/providers` | each adapter's own price mapping, optional capabilities and typed refusals |

Run the gates from the repo root: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Further reading

- [PLAN.md](./PLAN.md) — the design of record.
- [AGENTS.md](./AGENTS.md) — the rules for changing this package.
