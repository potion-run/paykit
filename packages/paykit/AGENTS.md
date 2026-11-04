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

## Model rules

- `decide` is pure: state and command in, events or a rejection out. No I/O, no clock, no
  provider, no ambient read.
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
  projection, never from a view.
- An admin action is a command, not a state write. No back doors, no direct row edits.

## Storage

`Paykit.Postgres` and friends are a `Domain.Platform`, not a schema: model, views, policies and
sagas are identical on Postgres, SQLite/D1 and `Domain.InMemory`. `Domain.InMemory` stays green
as the others land — it is the proof the seam holds.

A store keeps all five `AggregateStore` guarantees or it is not a store: one writer per account
id, dedupe by `commandId`, atomic commit of events + state + receipt + deliveries, at-least-once
delivery in order, `schedule`/`tail` by notify or poll. [PLAN.md](./PLAN.md#storage) gives each
database's mechanism.

Two table classes, no more: `billing_event` (append-only, the only truth) and `billing_rm_*`
(rebuildable at any moment). A read model that becomes a source of truth is a bug.

- Every table is `billing_`-prefixed, the schema is configurable, `public` is never touched.
- Migrations are additive, forward-only `SqlFile`s; an applied file is never edited.
  `paykit migrate --dry-run` prints the DDL before anyone runs it against a money table.
- `paykit doctor` rebuilds every read model into temp tables and prints the event ids that
  disagree. A store ships when `doctor` is clean.

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
`@potion.run/polar` for Polar (ours, [its own package](../polar/AGENTS.md), published
separately). They declare products, prices and the webhook endpoint as Alchemy resources and
expose checkout/portal/refund as bindings over their distilled SDK. The `Payments<V>` adapter
delegates to them — if an op is missing, add it to the vendor package, not to the adapter.

`@potion.run/polar` is a general Polar provider for Alchemy: a Worker that sells a product with
no paykit import is its README, and its live tests run without paykit. A paykit-shaped helper in
it is a leak in the wrong direction.

Adding a provider touches the same places every time:

1. **The vendor package** — `@alchemy.run/<vendor>` or `@potion.run/<vendor>`: products, prices
   and webhook endpoint as resources, checkout/portal/refund as bindings. Publish one only when
   none exists, general-purpose and never paykit-shaped.
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
  `Paykit.Polar()` never installs `@potion.run/polar`.
- Model files under `src/` are `<Noun>.<kind>.ts` (`.aggregate`, `.command`, `.rejection`,
  `.view`, `.stream`, `.projection`, `.saga`); runtime files use Alchemy's resource/binding
  pairing.

## Tests are the spec

| Suite | Proves |
| --- | --- |
| `test/stories` | every command's happy path and every rejection |
| `test/properties` | the six properties in [the correctness bar](./PLAN.md#correctness-bar) |
| `test/conformance` | every `Payments` implementation passes the cases its capabilities declare |

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
