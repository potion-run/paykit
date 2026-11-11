# @potion.run

The repo that publishes every `@potion.run` package, the way Alchemy publishes `alchemy` and
`@alchemy.run/*`. Each package is built on Alchemy and Effect. This file is the rule set;
[PLAN.md](./packages/paykit/PLAN.md) is the design of record, the [ADRs](./docs/adr/) are the
decisions, and each package has a README for its surface.

| Directory | Package | Owns |
| --- | --- | --- |
| `packages/paykit` | `@potion.run/paykit` | the model, the tenant and admin Apis, the stores, the ports |
| `packages/paykit-stripe` | `@potion.run/paykit-stripe` | Stripe as a processor: prices, meters, webhook |
| `packages/paykit-polar` | `@potion.run/paykit-polar` | Polar as a merchant of record: products, webhook |
| `packages/paykit-admin` | `@potion.run/paykit-admin` | the Foldkit ops console over `BillingAdminApi` |

Every `examples/*` deployment is an advertised usage and runs under `pnpm test`, so an API change
that breaks one breaks a gate. `billing` is the full Worker on D1, `saas` the vertical (entity,
transfer, add-on, guardrail, metered), `memory` the smallest deployment. A new package is
`packages/<name>`, named `@potion.run/<name>`, added to the workspace globs and the root
`tsconfig.json` project references in the same commit, with its own tests.

## Repo rules

- **One scope.** Every published package is `@potion.run/<name>`.
- **One version line.** Packages share a version and release together, like Alchemy's
  `2.0.0-beta.N`. Internal dependencies are `workspace:*`, and an optional peer pins the matching
  range, so two packages never drift.
- **The root does not publish.** Root `package.json` holds scripts and dev dependencies;
  `packages/*` publishes, while `examples/*`, `website/*` and `docs/*` do not.
- **Project references.** Each package owns a `tsconfig.json` and a `tsconfig.test.json`, and
  `scripts/` owns `scripts/tsconfig.json`; the root one references them all, so `pnpm typecheck` is
  `tsrs -b` over the whole graph and a broken consumer cannot land.
- **Tests live with the package.** A package with no tests is not done.
- **Four export groups and nothing else**: deploy-time resources, runtime bindings, model,
  providers. If a user can import it, it is API. An opt-in integration is an optional peer plus a
  dev dependency.

## Effect discipline

Every package runs on Effect, tests and helpers included. Pure functions stay plain, so a
generator can call them a million times.

| Don't | Do |
| --- | --- |
| `async` / `await`, raw `Promise` | `Effect.gen` / `Effect.fn` |
| `node:fs`, `node:path` | `FileSystem.FileSystem`, `Path.Path` |
| `process.env` | `yield* Config.*`, so the provided `ConfigProvider` is honored |
| `fetch` | `HttpClient.HttpClient` |
| `new Promise((r) => setTimeout(r, ms))` | `Effect.sleep` |
| `Date.now()` | `Clock.currentTimeMillis` |
| bare `crypto`, `Buffer`, `process.cwd()` | `Effect.sync(() => …)` |
| `throw` | a typed error the caller can match |

The `effecttsgo/*` rules in `oxlint.config.ts` encode most of this table and report from
`pnpm lint`. A finding is fixed at its last site, which is also what raises a rule from `warn` to
`error`.

## Alchemy API conventions

The Alchemy source is the tie-breaker for API shape. Paths below are relative to
`.agent_sources/github.com/alchemy-run/alchemy/`.

- **A `Resource` owns state; a value does not.** `Resource<...>("Type")` is for something to
  `Diff` / `Read` / `Reconcile` / `Delete` with a provider to own it. A declaration another
  resource validates and records is plain `Schema.Struct` data (`src/Resource.ts`,
  `Contributions.ts`).
- **`Input` stops at the resource boundary.** Resource props may be `Output`, `Config` or `Effect`;
  plain config values stay plain (`src/Input.ts`). A Props interface states plain types.
- **Pure constructors, one validating Effect.** Declarations are total and side-effect-free; the
  effectful entry point decodes and maps schema failures to a tagged error with context.
- **Schema is the source of truth.** Serializable values are `Schema.Struct`, domain messages
  `Schema.Class`, failures `Schema.TaggedError`, and a failure channel is one `Schema.Union` of
  them (`domain/src/Command.ts`, `Rejection.ts`). An id is
  `Schema.String.pipe(Schema.brand(…))`, so a bare string cannot stand in for one.
- **Errors carry evidence and are matched by tag**, never by message. `Schema.TaggedError` when the
  error is serialized or declared as a rejection, `Data.TaggedError` otherwise, with a `cause` when
  wrapping.
- **Name effectful spans; keep pure functions plain.** `Effect.fn("Namespace.operation")` for a
  handler, `Effect.fromResult` to lift a pure `Result`.
- **One Layer, provided once.** Build with `Layer.mergeAll`, provide with `Layer.provide`.
- **Secrets are redacted; payloads are not traced.** Anything secret is `Redacted`, and a span
  records only what a declaration's `attributes` returns.
- **Public primitives carry examples.** JSDoc on an exported primitive, binding, layer or resource
  has a runnable example, `###` sections, `**Example:**` labels, a field-level comment on every
  prop and attribute, and the generator tag last (`@primitive`, `@binding`, `@layer`, `@resource`).
  `website/docs/reference` is generated from that source, so a changed tagged block means
  `pnpm docs:reference` in the same commit.

## Resource providers

`paykit-stripe` and `paykit-polar` own Alchemy resources, so the rules in Alchemy's
[AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md) apply. Where an ADR says
something narrower (a price is never deleted, a hold is an entity), the ADR wins.

**Lifecycle.** **Diff** decides update or replace: `undefined` for the default update,
`{ action: "replace" }` when a create-only prop changed. **Read** may run without output, so derive
the physical identity deterministically or find the object by ownership metadata; a foreign object
is `Unowned(attrs)`, a missing one is `undefined`. **Pre-create/Observe** is for a real bootstrap
identity problem only — financial resources have none. **Reconcile** converges from every starting
point. **Delete** is idempotent, and for a financial record it is retention or archival. **List**
returns what `read` returns, or sets `nuke: { skip: true }`.

**Reconciler doctrine.** `reconcile` gets `output` and `olds`, in three shapes: greenfield
(`undefined`/`undefined`), routine update (defined/defined) and adoption (defined/`undefined`).
Write one flow for all three — a create body beside an update body re-introduces every assumption
the old split made:

1. **Observe** — derive the physical identifier, read live cloud state.
2. **Ensure** — create if missing, catch `AlreadyExists` / `Conflict` as a race, wait for active.
3. **Sync** — per mutable aspect, diff *observed* cloud state against desired and apply only the
   delta, skipping the API when nothing changed.
4. **Return** — re-read and return fresh attributes.

Cloud state is authoritative and `olds` is only a hint to skip a no-op call; `output` is a cache for
stable identifiers, not proof of existence; each sync step is independently idempotent; `NotFound`
and `ResourceInUse` are races, not failures; tags diff against observed metadata. The canonical
reconcilers are `aws/src/{S3/Bucket,SQS/Queue,DynamoDB/Table,EC2/Vpc}.ts` and
`cloudflare/src/Workers/Worker.ts` — read one before writing a new lifecycle.

**Ownership and identity.** Stamp `createInternalTags(id)` on every resource, mapped to the vendor's
metadata constraints (ours: each vendor package's `Metadata.ts`). Identity is the vendor's own
field — a Stripe lookup key, a Polar `metadata.paykit_tier` plus a stage-qualified name — so a
restored state reconciles to the same object, and a vendor id is only a cache. A name derives from
the stack, stage and logical id, never from a UUID, `Date.now()` or a random suffix. A Polar product
name is capped at 64 characters and `encodeVendorPart` expands non-alphanumerics (`_` becomes
`_5f_`), so the stage and tier fit that budget together;
`patches/@distilled.cloud__polar@1.0.0-rc.18.patch` is a type-only correction for `seat_tiers` to
remove when a catalog bump lands an SDK that names the current field, with the seat case in
`test/Prices.live.test.ts` as the check.

**Tests.** Use `test.provider` with `stack.deploy`, start and end with `stack.destroy()`, and
exercise create, update, replacement and removal — a replace proves the old object is retained or
archived. Verify cloud state out of band through the vendor SDK, the assertion of deletion included.
A fast fake may sit beside the live case as a contract test if its header says so; the deployment is
the authority for the vendor path.

## Versioning and history

### Resource state

**`provider.version` is the resource's own generation**: bump it in the same change that changes
what state means, and keep it equal to the shape version in the attributes.

- **Read, diff and reconcile accept older, refuse newer.** An older record is upgraded by the next
  reconcile; a newer one is a typed refusal, because an older build must never move that state back
  to an older layout. `read` alone is not enough — it also runs on a cold start — so `diff` and
  `reconcile` refuse the same record on a normal deploy
  (`cloudflare/src/Domain/Version.ts`).
- **A version bump forces the reconcile.** `diff` returns `{ action: "update" }` whenever the
  recorded shape is older, so the new record is written even when props did not change.
- **Migration lands in `reconcile`.** `read` observes and judges; `reconcile` converges and writes
  the current shape.

### Consumers (views, projections, streams)

- **A consumer's `version` is its generation.** Alchemy folds it and the generations of every view
  it reads into a target id (`view:Entitlements#2`, `projection:BillingRead#1`). That id is what
  sources route history to; a changed id means a new consumer, not an old one with new code.
- **Backfill is the deploy's job.** `Platform.start(targets, planOf, backfill)` replays the sources
  of every target that is new or whose generation changed. A view keyed by the one aggregate it
  reads carries `ViewKit.catchUp` instead. Both are `kit.history(target, source, id, rows)`, never a
  hand-built fold.
- **Order follows the graph**, and **a changed plan needs a version bump**: a platform that finds a
  different plan under the same target id refuses the build (`Backfill.PlanChanged`).
- **`history(target)` reports completeness.** A consumer the backfill has not finished is never
  complete.
- **Generation is part of dedupe.** A consumer rebuilt from an earlier generation starts over: drop
  deliveries routed to the old generation, reset its input log and cursor.

### Events and migrations

- **Events are append-only API.** Add a field; never rename or repurpose one. A projection change is
  a rebuild through the consumer's `version`, not a rewrite of the log.
- **SQL migrations are additive and forward-only.** Append a record; never edit one already in
  `migrationFiles`. `@alchemy.run/sql/Migrations` owns the bookkeeping table, the content hashes and
  the refusal of a rewritten or removed applied file.
- **A money table is never dropped to migrate it.** A vendor object a bill references is retained or
  archived ([ADR 0003](./docs/adr/0003-the-deploy-provisions-the-vendor.md)), and the state a
  customer was sold is rewritten by reconcile.

## The paykit model

[PLAN.md](./packages/paykit/PLAN.md) is the design of record and wins where this file is silent; its
non-goals are commitments, and its `## Storage`, `## Surfaces`, `### Auth` and `## Correctness bar`
carry the rules for those areas. Read the section you are about to touch, and read [ADR
0001](./docs/adr/0001-catalog-states-the-pricing-model.md) before changing what the catalog can
express.

**Two planes: entitlement is ours, money is the provider's.** `check()` answers from one local read,
returning allowed, remaining, `resetsAt` and standing, so an entitlement is never a provider round
trip and provider vocabulary never reaches the model. Checkout, cards, tax, invoices and retries sit
behind the `Payments` port.

The public words are those in PLAN's `## Vocabulary`. `Tier` and `Allowance` are internal names
while the state migrates, not a second public API; a second spelling of an existing word is a
breaking change.

The per-command loop, under `src/`, in this order:

1. **Rejection** — `<Rejection>.rejection.ts`, one per way the command can refuse, carrying what
   an operator needs to explain it.
2. **Command** — `<Command>.command.ts`: the payload, and the catalog fields a handler must not
   invent.
3. **`decide`** — the guard, the events, and the numbers those events carry forward. Pure: no I/O,
   no clock, no provider, no `Actor`, no ambient read.
4. **`evolve`** — copy the event's outcome into state, unchanged.
5. **Views** — fold the event if it moves a number a user sees.
6. **Story** — the happy path and every rejection, one `Story` each.
7. **Property** — add the command to the generated sequence.

Done when `Domain.verify(Model)` returns empty and the stories and properties are green. A rejection
without a story is unimplemented, and a property that has never failed proves nothing: it is written
red first.

A counter is a fold of the event log — a number replaying the log cannot reproduce is a bug, not a
cache. Every price a command records travels on its event (`price`, `priceBefore`, `priceAfter`,
`UsageRecorded.charge`), so the log answers "what were we charging" without the catalog, and a
catalog price change never moves a standing that already exists. A write that would exceed a
blocking allowance is refused in the same transaction that would have recorded it, deduped by
`dedupeKey`. `decide` moves a standing only where `STANDING_PHASE_TRANSITIONS` names the edge
(`test/standing/Phase.test.ts` walks the table).

## The console

`paykit-admin` is a client of `BillingAdminApi`, not a second billing model: `BillingState` and
`Entitlements` are the truth, `AccountEvents` the history, and the Model holds routes, filters,
drafts, command ids, query ids and pending outcomes.

- The URL is the navigation state (`reflectRoute` / `routeOf`), so a selection the URL cannot
  reproduce is dropped. A seeded snapshot is the first frame of a live read, not a second source.
- Every write is a `BillingAdmin` command whose `commandId` comes from `next(model.commandIds)`; a
  retry of `Unknown` reuses it. A read is applied only while its `requestId` is the one being
  waited for.
- Keep the typed failure (`Rejected`, `Denied`, `Unknown`) so an operator sees the evidence behind
  a refusal; a transport failure keeps the RPC reason tag as well as the message.
- A preview is a question and records nothing. A tier change is a quote, then an apply.
- Credits are counts (`formatCredits`), money is integer minor units (`formatMoney`), and both are
  formatted at the view edge.
- Compose `@foldkit/ui` and the local `src/ui` kit; a new button, field or table imports the kit,
  and colour comes from the `--pk-*` tokens.

## Providers are ports

`Payments` is the only door to money and no provider owns its shape: `Memory`, `Manual`, `Stripe`
and `Polar` pass one conformance suite parameterized by declared capabilities (`checkout`,
`invoice`, `charge`, `refund`, `portal`, `usage`, `quantity`, `setup`). That suite, not a vendor's
docs, is the definition of the port; if the port only fits Stripe it is not a port. `Manual` is the
reference.

- The model never imports a provider. Vendor ids live in `refs`, keyed by provider, and the catalog
  carries none: the tier → vendor mapping is provider config, with `CatalogPriceMismatch` as the
  deploy-time backstop.
- A missing capability is `ProviderCapabilityMissing` naming provider and op.
- A webhook translates at the edge, with the provider's event id as the `commandId`, so a
  redelivery is a replay rather than a second charge.
- A refund is capped by the log — `RefundExceedsCharged` rather than a negative payment — and it
  moves money without touching the credit pool ([ADR
  0019](./docs/adr/0019-a-refund-names-the-charge-it-reverses.md)).
- The value a vendor package returns is a `MoneyProvider`: Alchemy owns `Provider` for the service
  that reconciles a resource.
- `paykit-stripe` and `paykit-polar` are paykit-shaped on purpose. They import `@potion.run/paykit`
  and stay the shortest path from a catalog to a working vendor; a general Stripe provider is
  `@alchemy.run/stripe`, and a general Polar one would be a new package.
- A vendor resource is retained ([ADR 0003](./docs/adr/0003-the-deploy-provisions-the-vendor.md),
  [ADR
  0010](./docs/adr/0010-a-price-that-leaves-the-catalog-is-archived-not-deleted.md)), so a tier that
  leaves the catalog leaves a financial record. **Money outlives the stack**: the ledger is
  application data, so a delete path cancels, refunds and deletes no provider state — a `destroy`
  that cancels a live subscription is a support incident.
A new provider lands as: the vendor package or Alchemy bindings, the `Payments<V>.ts` adapter
delegating to them, the webhook translation, the provider config, and a conformance run green
beside `Manual`'s plus a story that signs a webhook and reads the answer back out of `check()`. Done
when `Manual` and the new provider pass the same cases and no `Subscription/*` file changed.

## Tests are the spec

`test/stories` covers every command's happy path and every rejection; `test/properties` the eight
properties in [the correctness bar](./packages/paykit/PLAN.md#correctness-bar) plus money as a fold
of the log, read/write agreement and delivery dedupe; `test/conformance` every `Payments`
implementation; `test/surfaces` the derived MCP tool list and CLI; `test/Api.test.ts` each guard's
refusals.

A bug found in the wild lands as the smallest story that reproduces it, with the event log that
produced it pasted beside it. `TestClock` everywhere, deterministic ids derived from the test name,
and bounded `Effect.repeat` + `Schedule` polling.

## Tooling

- **One catalog.** A package declares `catalog:`, never a version; `pnpm-workspace.yaml` is the only
  place a version is written.
- **anti-slop** (`tools/oxlint/anti-slop`) vendors the generic and Effect Oxlint plugins from
  `dmmulroy/anti-slop`; rule policy is `oxlint.config.ts`, provenance and the update procedure are
  `tools/oxlint/anti-slop/UPSTREAM.md`.
- **effect-tsgo** (`pnpm prepare:patch`, run by `prepare`) patches `oxlint` and `oxlint-tsgolint` in
  `node_modules` so the `effecttsgo/*` rules run type-aware. An install that skips `prepare` fails
  `pnpm lint` with `Unknown plugin: 'effecttsgo'`, and `@effect/tsgo` bumps together with `oxlint`,
  `oxlint-tsgolint` and `tsrs`.
- **Manifest gates** (`pnpm exports:check`, `pnpm validate:publish-packages`) read every
  `package.json` through Effect's `FileSystem`/`Path`: the export map matches `src/`, packages share
  one version, an internal dependency is `workspace:*`.
- **husky** owns the git hooks; the pre-commit hook formats staged files.

## Source-first

Effect, Alchemy and Foldkit are read from source before their APIs are guessed. `pnpm
vendor:agent-sources` shallow-clones them under `.agent_sources/github.com/<owner>/<repo>/` at the
refs the catalog pins, with `.agent-source.json` beside each clone; `--refresh` on
`scripts/vendor-agent-sources.sh` re-clones at the current pins. Read the installed
`packages/*/node_modules/effect/AGENTS.md` first: it ships with the version and never goes stale.

| Mirror | Read for |
| --- | --- |
| `.agent_sources/github.com/Effect-TS/effect/` | Effect v4 Schema, Context.Service, Config, platform, SQL, tests |
| `.agent_sources/github.com/alchemy-run/alchemy/` | resources, Cloudflare and Stripe providers, Stack API |
| `.agent_sources/github.com/foldkit/foldkit/` | Foldkit UI, effects and subscriptions |

The mirrors are reference material, gitignored and excluded from typecheck, lint and format.

## Formal model

The billing protocols are modelled in Quint, **one model per protocol, not one per module**
([ADR 0034](./docs/adr/0034-one-quint-model-per-protocol.md)). `specs/paykit/paykit.qnt` is the
spend path; `standing.qnt`, `windows.qnt`, `plans.qnt`, `schedules.qnt`, `balances.qnt`, `entities.qnt`,
`money.qnt` and `controls.qnt` are the other slices. `specs/paykit/README.md` maps every action to
its command, every invariant to its ADR, and says what each slice leaves out.

- **A refusing command is a disabled action.** The model checks the accept-set and a `run` checks
  the refusal; a rule that conserves nothing is a test, not an invariant.
- **The model is smaller than the code.** `int` credits, a step counter instead of a clock, three
  features, one account. The arithmetic is not modelled — `Pricing.test.ts` owns the formulas.
- **`scripts/spec-mutants.ts` proves the invariants bite**, so an invariant lands with its mutant
  in the same change. **`scripts/spec-coverage.ts` is the drift gate**: every `*.command.ts` needs
  a row.
- **`quint run` is the gate, `quint verify` is not.** Apalache is a manual run recorded in
  `specs/paykit/README.md`.
- **The spec is not a second implementation.** Run `pnpm spec` before changing a modelled command.

## Gates

Before you commit: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm spec`,
`pnpm build`, then `node scripts/smoke-artifact.mjs`. No gate before `pnpm build` compiles `lib/`,
so that build and the smoke script are what prove a published artifact loads. Formatting is
fixable in place (`pnpm format`, `pnpm lint:fix`); the type check, the tests and the manifest gates
are fixed in the code.

`.github/workflows/check.yml` runs every gate on every push and pull request.
`.github/workflows/live.yml` is the one gate that needs a vendor account: its cases skip without
`STRIPE_API_KEY` / `POLAR_API_KEY` and mutate a real test account, so a secret stays out of the path
of a pull request from a fork.

## Commits and PRs

- Conventional commit titles, scoped to the package: `feat(paykit): record usage in the same
  transaction that checks the allowance`.
- A PR body starts with plain prose, then snippets or bullets. `###` is the deepest heading,
  never `#`/`##`, and never a heading repeating the PR title.
- A snippet over a paragraph explaining it, and no "Test plan" section.
- Outstanding work: mark the PR draft and say in the chat that opened it what is missing.

## Further reading

- [What to build next](./docs/NEXT.md) — the queue, the traps, and the invariants a next slice
  must not break.
- [Billing surface](./docs/BILLING-SURFACE.md) — what the library, the provider and the deployment
  each own, and which gaps are still the library's.
- [ADRs](./docs/adr/) — read
  [0006](./docs/adr/0006-postpaid-usage-is-a-unit-price-in-the-catalog.md) before touching
  `unitPrice`, `moneyCap` or `UsageRecorded.charge`.
- [Alchemy AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md) — engine
  concepts, the Reconciler doctrine, the Typed Error Doctrine and the binding conventions.
