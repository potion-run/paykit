# paykit

`@potion.run/paykit` — billing and entitlement for Alchemy. You declare a catalog beside your
stack, the library keeps each account's **standing**, and `check()` answers from local state in
one read.

A subscription is not a payment. A payment is an event that changes a standing. Every rule here
derives from that sentence. [PLAN.md](./PLAN.md) is the design of record and wins wherever this
file is silent: vocabulary, domain model, storage contract, milestones.

**Read PLAN.md before you name anything, add a public export, or change what a command does.**
The non-goals in it are commitments — if a feature needs a compliance officer, it is not in this
package.

This package is one of the `@potion.run` packages. Repo rules — workspace layout, versioning,
Effect discipline, gates — live in [the root AGENTS.md](../../AGENTS.md).

## The two planes

| Plane | Owner | Rule |
| --- | --- | --- |
| Entitlement | us | `check()` answers from one local read: allowed, remaining, `resetsAt`, standing. No provider round trip, ever. |
| Money | the provider | Checkout, cards, tax, invoices, retries sit behind the `Payments` port. |

A provider call never decides an entitlement, and provider vocabulary never reaches the model.
Every "just read it from the provider" is a migration we owe later.

## Vocabulary is API

`Tier`, `Feature`, `Allowance`, `Subscription`, `Period`, `Usage`, `Standing` are fixed words;
renaming one is a breaking change. Before naming a type, a file or an export, read the
[vocabulary table](./PLAN.md#vocabulary) — its "Not to be called" column is the collision you
are about to hit.

## Catalog authoring

The catalog is plain data that `BillingStack` validates and records. `Feature`, `Tier` and
`Catalog` are not Alchemy resources: no `Diff` / `Read` / `Reconcile` / `Delete`, no `Type`, no
`FQN`. `BillingStack` is the resource; the catalog is its desired state. The root
[Alchemy API conventions](../../AGENTS.md#alchemy-api-conventions) are the general rule.

```ts
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
  grants: [Paykit.allowance(messages, { included: 2_000, overage: "bill" })],
});

Paykit.catalog({ features: [messages], tiers: [free, pro] });
```

- `feature()` declares a meter once. `FeatureId` and `TierId` are branded; a tier quotes a
  feature by value through `allowance()`, never by a bare string.
- `tier()` bundles at least one allowance. A missing `price` is free; prices are integer minor
  units plus a currency.
- `catalog()` / `defineCatalog()` validate the graph and refuse with `CatalogError`, a
  `Schema.Union` with one tag per refusal. A new semantic rule gets a new tag carrying its
  evidence and a test; `CatalogInvalid` is only for a schema failure.
- Constructors stay pure; `catalog()` is the only effectful step. Lookups are `tierOf`,
  `featureOf` and `allowancesOf`.
- No provider ids in the catalog. The tier → vendor price mapping lives in provider config;
  `CatalogPriceMismatch` in `Stack` is the backstop.
- A public catalog function carries a JSDoc example, like an Alchemy primitive.
- A command that records money carries the number it recorded (`price` on activation, `priceBefore`
  and `priceAfter` on a change). A catalog whose price moves never rewrites a standing that already
  exists, so the log alone answers "what were we charging".

## Model rules

- `decide` is pure: state and command in, events or a rejection out. No I/O, no clock, no
  provider, no ambient read — and no `Actor`, so authorization is middleware, never a model
  rule that depends on which surface sent a command.
- Time arrives as command data or from the supplied `Clock`. `Date.now()` inside `decide` is a
  bug the properties will find for you.
- Money is `Schema.Int` minor units with a currency on every amount. No floats, no dollars.
- `evolve` copies the outcomes events carry (`remainingAfter`, `periodAfter`); it never
  re-derives a rule that `decide` already decided.
- Counters are a fold of the event log. A number that cannot be reproduced by replaying events
  is a bug, not a cache to invalidate.
- Events are public API: add a field to one, never rename or repurpose it. A projection change is
  a rebuild through `Backfill`/`CatchUp`, not a rewrite.
- A `Track` that would exceed a blocking allowance is refused in the same transaction that would
  have recorded it. Never check-then-write, and dedupe by `dedupeKey` so a retry records once.
- `ChangeTier` ships next-period-only first. Mid-cycle proration is a second pass with its own
  properties in `src/Proration.ts`.
- A reservation moves `remaining` and `reserved`, never `usage`. `SettleUsage` bills the held
  units and `ReleaseUsage` returns them; settling or releasing more than is held is a typed
  rejection, so a leak surfaces as an error rather than a shrinking allowance.
- Prices are logged. `SubscriptionActivated` carries `price`, `TierChanged` carries
  `priceBefore`/`priceAfter`, and a downgrade to a free tier records the absence of a price.
  A catalog price change never rewrites a standing that already exists.
- Every command has one typed rejection per way it can refuse.

## The per-command loop

Adding or changing a command touches the same set of files under `src/`, in this order:

1. **Rejections** — `<Rejection>.rejection.ts` per new refusal, carrying what an operator needs
   to explain it.
2. **Command** — `<Command>.command.ts`: payload schema, and the fields a handler must not invent.
3. **`decide`** — the guard, the events it emits, and the numbers those events carry forward.
4. **`evolve`** — copy the event's outcome into state, unchanged.
5. **Views** — `Entitlements` / `BillingState` fold the event if it moves a number a user sees.
6. **Story** — happy path and every rejection, one `Story` each.
7. **Property** — include the command in the generated sequence, so replay, idempotence and
   delivery-order properties cover it.

Done when `Domain.verify(Model)` returns empty, the stories are green, and the properties are
green against generated sequences that include the new command.

## Surfaces

Tenant and admin are two `Api`s over one model, with different middleware and different blast
radius. `Foldkit.make(BillingAdminApi)` derives the console — do not hand-write command plumbing
around it.

- Both surfaces go through the same `Command` with a `commandId` and typed `reply`. `Unknown`
  means exactly "retry with the same id", so a double click cannot double-credit.
- A view folds one key's events. Cross-account lists and metrics come from the `BillingRead`
  projection through `Paykit.List`, never from a view. `after` is a cursor, not an offset.
- An admin action is a command, not a state write. No back doors, no direct row edits.
- `@potion.run/paykit/Surfaces` is the only place MCP and CLI live, and it derives both from
  the two Apis: `DomainAi.toMcp`, `DomainAi.toToolkit`, `DomainCli.toCli`. Never hand-write a
  tool list or a subcommand. It is a separate entry point so HTTP-only apps never load
  `effect/ai` or `effect/cli`.
- A tool is a projection of an Api: one per command and per non-stream read, named
  `<Api>_<Name>_<operation>`, `Destructive` for a command and `Readonly` for a read, with a
  rejection returned as a tool failure. `watch` and `events` are streams, not tools.
- The Api is the unit of authorization. `toMcp` runs each tool call through the Api's own
  middleware using the MCP request's headers, so serving the two Apis at two paths is the whole
  security model. Never merge them.
- `Paykit.Preview` runs the same pure `decide` and reports the events and proration a command
  would produce. Show the charge before applying it; a write an agent may retry carries a
  `commandId`.

## Auth

`Session` and `Admin` are the two `RpcMiddleware` services in `src/Auth/`. A command declares the
weakest guard it needs; the Api's composition of commands is the blast radius.

- `Session` resolves the `Actor` and pins an `account` actor to its own account id; an `admin`
  or the `system` actor may act on any account. Both views declare it and re-check the key in
  `validate`, so a read is scoped even if a route forgot to be.
- `Admin` requires `kind === "admin"`. `GrantCredits`, `ExtendTrial`, `EnterGrace`, `Recover`,
  `Expire` and the payment commands declare it, so a tenant session cannot reach them.
- In-process senders — `Webhooks`, `Track`, `Hold`, `Subscribe` — provide the actor with
  `asSystem`. The deployment already authenticated the work; a send without a guard is for
  `PeriodEnded`, `GraceElapsed`, `ClosePeriod` and `AttachProviderRef` only.
- `SessionFromHeaders` and `AdminFromHeaders` read `x-paykit-actor` and `x-paykit-kind`. They are
  development guards. Production replaces them with a Layer over its own session; the header
  must never become an authentication scheme by accident.
- A new command without a guard is a review failure unless it is a system fact. Say why in the
  command's JSDoc.
- `CatalogGuard` sits on the three commands that carry catalog-derived fields (`Subscribe`,
  `ChangeTier`, `StartTrial`). `decide` is pure and cannot look a price up, so the command carries
  it — and the guard refuses a payload whose `tier`, `allowances` or `price` disagrees with the
  catalog the deployment validated. Never make the guard "correct" a payload: a client bug must not
  become a wrong invoice.

## Storage

`Paykit.Postgres` and friends are a `Domain.Platform`, not a schema: model, views, policies and
sagas are identical on Postgres, SQLite/D1 and `Domain.InMemory`. `Domain.InMemory` stays green
as the others land — it is the proof the seam holds.

Every store takes the **asynchronous** executor and wraps a multi-row write in `sql.atomic`: a
view's snapshot, entries and input rows; a projection's cursor and processed rows; a stream's
entries and meta. Nothing writes two rows outside a unit and nothing reads synchronously. The schema
a hosted database applies is generated — `scripts/schema.ts` renders `migrationFiles` — so the file
a release runs and the DDL a test runs come from one source; regenerate it rather than editing it.

A store keeps all five `AggregateStore` guarantees or it is not a store: one writer per account
id, dedupe by `commandId`, atomic commit of events + state + receipt + deliveries, at-least-once
delivery in order, `schedule`/`tail` by notify or poll. [PLAN.md](./PLAN.md#storage) gives each
database's mechanism.

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
- `SqlAggregateStore` is the only thing that writes the log, and each of the five guarantees has
  one place in it. Do not add a path that writes `billing_event` without its state, receipt and
  deliveries in the same transaction, and do not deliver before the commit: the outbox row is what
  makes a crash replay instead of drop.
- Code or a test copied from Alchemy keeps a header with the upstream path and the
  catalog-pinned ref. Keep the copied shape 1:1 where it is a compatibility check; the mirrors
  under `.agent_sources/` and the catalog bump then make the next change a diff.

## Providers are ports

`Payments` is the only door to money, and no provider owns its shape. `Memory`, `Manual`,
`Stripe` and `Polar` pass one conformance suite — parameterized by declared capabilities — and
that suite, not a vendor's docs, defines the port. `Manual` (invoice payable by transfer) is the
reference: if the port only fits Stripe, it is not a port.

Processors (Stripe) move money; merchants of record (Polar) also own tax, receipts and the
customer portal. The port is what they share, and a provider declares the rest. The model never
imports a provider — the adapter is wired by the user, behind the port. `0.1` runs one provider
per Stack; `refs` is keyed by provider, so a second one is additive.

- **The catalog carries no provider ids.** Tier → price mapping lives in the provider config,
  so the same catalog runs on every provider.
- **Vendor ids live in `refs`**, keyed by provider. Nothing else in the model learns `cus_…`.
- **The provider's entitlement view is a projection of ours.** Polar benefits and Stripe
  entitlements are written after a tier change; `check()` never reads them back.
- **The price has one meaning.** The catalog states it, the vendor package charges it, and
  `Stack` fails with `CatalogPriceMismatch` when the mapping disagrees.
- **Webhooks translate at the edge**, into our events, with the provider's event id as the
  `commandId` so a redelivery is a replay, not a second charge.
- **A missing capability is a typed error**, `ProviderCapabilityMissing`, naming provider and
  op. The console hides the action; nothing degrades silently.

A **vendor package** owns the vendor's plumbing: `@alchemy.run/stripe` for Stripe, and
`@potion.run/paykit-polar` for Polar (ours, [its own package](../paykit-polar/AGENTS.md),
published separately). They declare products, prices and the webhook endpoint as Alchemy
resources and expose checkout/portal/refund as bindings over their distilled SDK. The
`Payments<V>` adapter delegates to them — if an op is missing, add it to the vendor package, not
to the adapter.

`@potion.run/paykit-polar` is a **paykit package**, not a general Alchemy provider: it imports
`@potion.run/paykit` and exports the one call that stands Polar up as a merchant of record. That is a
maintenance decision, not a coupling accident — a general provider would need its own users, docs and
release train, and we would carry all of it to serve one adapter. If someone needs Polar without
paykit, that is a different package with a different name.

Stripe needs no such package: `@alchemy.run/stripe` exists, so paykit's adapter lives in
`PaymentsStripe.ts` behind the optional peer and `stripeBindings(...)` maps that package's bindings
onto the port.

Adding a provider touches the same places every time:

1. **The vendor package** — `@alchemy.run/<vendor>` when one exists, else
   `@potion.run/paykit-<vendor>`, which is then paykit-shaped on purpose: products, prices and webhook
   endpoint as resources, checkout/portal/refund as bindings, and a single call that returns the
   `Provider` the catalog needs.
2. **The adapter** — `Payments<V>.ts`: delegate to those bindings; required ops, plus the
   optional ops it declares.
3. **The translation** — its webhooks into our commands, provider event id as `commandId`.
4. **The config** — its products in the provider config; the catalog does not move.
5. **The suite** — its conformance run, green alongside `Manual`'s.

Done when `Manual` and the new provider pass the same cases and no `Subscription/*` file changed.

## Money outlives the stack

:::warning
The ledger is application data, not stack state. `RemovalPolicy.RETAIN` on catalog and account
resources, and nothing in a delete path cancels, refunds or deletes provider state. A `destroy`
that cancels a live subscription is a support incident.
:::

The README says this next to the quickstart.

## Public surface

Four export groups and nothing else: deploy-time resources, runtime bindings, model, providers.
`src/index.ts` re-exports those four. If a user can import it, it is API — everything else stays
internal, whatever it is.

- Opt-in integrations are an optional peer plus a dev dependency, so a user who never imports
  `@potion.run/paykit-polar` never installs it.
- Model files under `src/` are `<Noun>.<kind>.ts` (`.aggregate`, `.command`, `.rejection`,
  `.view`, `.stream`, `.projection`, `.saga`); runtime files use Alchemy's resource/binding
  pairing. Plain values keep plain names (`Feature.ts`, `Allowance.ts`, `Tier.ts`, `Catalog.ts`).

## Tests are the spec

| Suite | Proves |
| --- | --- |
| `test/stories` | every command's happy path and every rejection |
| `test/properties` | the eight properties in [the correctness bar](./PLAN.md#correctness-bar) |
| `test/conformance` | every `Payments` implementation passes the cases its capabilities declare |
| `test/surfaces` | the MCP tool list and the CLI are derived from the Apis, not written twice |
| `test/Api.test.ts` | each guard refuses what it should: no caller, another account, an operator command |

Write the property red first. A property that has never failed proves nothing, and a rejection
without a story is unimplemented.

- `TestClock` everywhere. A billing test that waits in real time will flake.
- Deterministic data: account ids are constants or derived from the test name. No `Math.random()`
  and no `Date.now()` for identity.
- Poll with `Effect.repeat` + `Schedule` and a bounded `times`, never
  `while (Date.now() < deadline)`.
- A bug found in the wild lands as the smallest story that reproduces it, with the event log
  that produced it pasted beside it.

## Working here

1. **Orient.** Read [the milestones](./PLAN.md#milestones) and the PLAN section you are about to
   touch. The plan is the spec; this file is the working agreement. When the code and the plan
   disagree, the plan wins — or the plan is genuinely out of date, and you change it on purpose,
   in its own commit, saying why.
2. **Build in milestone order.** M0 → M6. Do not open M(n+1) until M(n)'s exit criterion holds,
   and do not widen a milestone with a feature from a later one.
3. **Model, then store, then providers.** The model is proven against `Domain.InMemory` before a
   SQL store exists.
4. **Gate before done.** The root gates are `pnpm typecheck` and `pnpm test`; both green. Fix
   the check rather than the test.

## Further reading

- [PLAN.md](./PLAN.md) — design of record.
- [Root AGENTS.md](../../AGENTS.md) — workspace layout, versioning, Effect discipline, git.
- [Alchemy AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md) — engine
  concepts, the Reconciler doctrine and binding conventions. Read the Reconciler doctrine before
  writing `Diff` / `Read` / `Reconcile` / `Delete` for a store.
- [Alchemy source mirror](../../.agent_sources/github.com/alchemy-run/alchemy/) — once vendored,
  the pinned source for the API rules above:
  `packages/alchemy/src/{Resource,Input,Contributions}.ts` and
  `packages/domain/src/{Command,Event,Rejection}.ts`.
