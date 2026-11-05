# @potion.run

The repo that publishes every `@potion.run` package, the way the Alchemy repo publishes `alchemy`
and `@alchemy.run/*`. Each package is built on Alchemy and Effect and carries its own doctrine
beside its source.

## Packages

| Package | Directory | What it is | Read next |
| --- | --- | --- | --- |
| `@potion.run/paykit` | `packages/paykit` | Billing and entitlement for Alchemy | [AGENTS.md](./packages/paykit/AGENTS.md) · [PLAN.md](./packages/paykit/PLAN.md) |
| `@potion.run/paykit-polar` | `packages/paykit-polar` | Polar as a paykit provider, and the products its tiers are sold as | [AGENTS.md](./packages/paykit-polar/AGENTS.md) |

`examples/billing` is a runnable Worker that bills with `MemoryStore` and the `Manual` provider, so
it needs no database and no provider key. It is in the workspace, in the root `tsconfig.json` and in
`pnpm test`, so an API change that breaks the advertised usage breaks a gate.

A new package is `packages/<name>`, named `@potion.run/<name>`. Give it an `AGENTS.md` when it
carries rules a reader needs before touching it, and add it to the workspace globs and the root
`tsconfig.json` project references in the same commit.

`spec/` holds TLA+ models of what no test can reach — two writers on one account, a deadline firing
mid-flight, an outbox that redelivers, a crash between a side effect and its record. They are
checked by `pnpm spec`; read [`spec/README.md`](./spec/README.md) before adding or changing one.

## Repo rules

- **One scope.** Every published package is `@potion.run/<name>`. Nothing unscoped, nothing under
  a second scope.
- **One version line.** Packages share a version and release together, like Alchemy's
  `2.0.0-beta.N`. Internal dependencies are `workspace:*`, and an optional peer pins the
  matching range, so two packages never drift.
- **The root does not publish.** Root `package.json` holds scripts and dev dependencies;
  `packages/*` publishes, while `examples/*`, `website/*` and `docs/*` do not.
- **Project references.** Each package owns a `tsconfig.json` and a `tsconfig.test.json`, and
  `scripts/` owns `scripts/tsconfig.json`; the root one references them all. `pnpm typecheck` is
  `tsrs -b` over that graph, so a change in one package cannot land with a broken consumer, and a
  tooling script is typechecked like any other source.
- **Tests live with the package.** `pnpm test` fans out. A package with no tests is not done.

## Tooling

- **pnpm 12** with one catalog in `pnpm-workspace.yaml`. A package declares `catalog:`, never a
  version; the catalog is the only place a version is written.
- **tsrs** compiles the type graph (`pnpm typecheck`), with `tsc` as the reference compiler where
  tsrs ships no binary. `scripts/build-package.ts` runs `tsrs -b --force` for `pnpm build`.
- **oxlint** (`pnpm lint`) runs type-aware rules; **oxfmt** (`pnpm format`) formats source and
  `package.json`, and `pnpm format:check` is the gate. The pre-commit hook runs the formatter.
- **effect-tsgo** (`pnpm prepare:patch`, run by `prepare`) patches the installed `oxlint` and
  `oxlint-tsgolint` binaries so the `effecttsgo/*` rules in `oxlint.config.ts` run type-aware.
  The patch lives in `node_modules`, so an install that skips `prepare` fails `pnpm lint` with
  `Unknown plugin: 'effecttsgo'`. Bump `@effect/tsgo` only alongside `oxlint`,
  `oxlint-tsgolint` and `tsrs`: its README names the versions each release supports.
- **manifest gates** (`pnpm exports:check`, `pnpm validate:publish-packages`) read every
  `package.json` through Effect's `FileSystem`/`Path`. The export map must match `src/` and the
  form npm publishes, packages must share one version, and an internal dependency is
  `workspace:*`.
- **alchemy-test** (`@alchemy.run/test`) runs each package's `test/*.test.ts` under Bun.
- **tla-ts** (`pnpm spec`) model-checks the `spec/*.tla` models against their `spec/*.cfg` scope —
  TLC without the JVM, so the gate needs nothing beyond `pnpm install`.
- **husky** owns the git hooks; `pnpm prepare` installs them on install.
- **agent sources** (`pnpm vendor:agent-sources`) shallow-clones Effect, Alchemy and Foldkit
  into `.agent_sources/` for source-first reading; see [Source-first](#source-first).

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
`pnpm lint`. A rule at `error` is a gate. A rule at `warn` has a finding outstanding: fix it, or
raise the rule by fixing its last site — never by adding a disable comment.

## Alchemy API conventions

The Alchemy source is the tie-breaker for API shape. Read the mirror before designing a public
type or constructor; these are the rules this repo follows. Paths below are relative to
`.agent_sources/github.com/alchemy-run/alchemy/`.

- **A `Resource` owns state; a value does not.** Use `Resource<...>("Type")` only when there is
  something to `Diff` / `Read` / `Reconcile` / `Delete` and a provider to own it. A declaration
  that another resource validates and records is plain `Schema.Struct` data, not a resource
  (`packages/alchemy/src/Resource.ts`, `Contributions.ts`).
- **`Input` / `PropsInput` stops at the resource boundary.** Resource props may be `Output`,
  `Config` or `Effect`; plain config values must stay plain, or a provider id leaks somewhere
  that should not know it (`packages/alchemy/src/Input.ts`).
- **Pure constructors, one validating Effect.** Declaration functions are total and
  side-effect-free. The effectful entry point decodes and maps schema failures to a tagged error
  with context: `Contributions.make` for the declaration, `readManifest` for the validator
  (`packages/alchemy/src/Contributions.ts`).
- **Schema is the source of truth.** Serializable values are `Schema.Struct`; domain messages are
  `Schema.Class`; failures are `Schema.TaggedError`; a failure channel is one `Schema.Union` of
  them (`packages/domain/src/Command.ts`, `Rejection.ts`).
- **Brand identities.** Ids are `Schema.String.pipe(Schema.brand("..."))`, so a bare string cannot
  stand in for one (`packages/domain/src/Aggregate.ts`).
- **Errors carry evidence and are matched by tag.** No `throw`, no generic `Error`, no
  message-string matching. Use `Schema.TaggedError` when the error is serialized or declared as a
  rejection; `Data.TaggedError` when it does not cross a schema boundary. Include a `cause` when
  wrapping (`Contributions.ContributionError`, `State/HttpStateApi.ts`).
- **Name effectful spans; keep pure functions plain.** `Effect.fn("Namespace.operation")` for a
  handler, `Effect.fromResult` to lift a pure `Result` (`Contributions.load`, `Auth/Demand.ts`).
- **One Layer, provided once.** Build with `Layer.mergeAll` and provide with `Layer.provide`;
  never chain `Effect.provide` through every call site.
- **Secrets are redacted; payloads are not traced by default.** Anything secret is
  `Redacted` / `Schema.Redacted`, and a span records only what a declaration's `attributes`
  returns (`packages/domain/src/Command.ts`, Alchemy AGENTS.md).
- **Public primitives carry examples.** JSDoc on an exported primitive or resource includes a
  runnable example and the tag a docs generator reads (`@primitive`, `@resource`, `@layer`); the
  source is the docs source of truth (`packages/stripe/src/Price.ts`, Alchemy AGENTS.md).

## Resource providers

The vendor packages (`paykit-stripe`, `paykit-polar`) own Alchemy resources, so the rules in
Alchemy's [AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md) apply here. This
section copies the resource part of that file — the lifecycle, the Reconciler doctrine, ownership
testing and the test conventions — so a change to a resource does not have to leave the repo to find
them. Where an ADR says something narrower (a price is never deleted, a hold is an entity), the ADR
wins.

### Lifecycle operations

A provider implements:

- **Diff** — compares new props with old props and decides update or replace. For an update it may
  name stable properties. Use it as an optimization and to identify replacement, not as a third
  path: return `undefined` / `void` for the default update, `{ action: "replace" }` when a
  create-only prop changed, and never return `no-op` unless the change is deliberately ignored.
- **Read** — reads current cloud attributes. It can run without current output (state was lost), so
  derive the physical identity deterministically or find the object by ownership metadata. Return
  `Unowned(attrs)` for an existing object that is not ours; the engine refuses adoption unless
  `--adopt` is set. A missing object is `undefined`, not a failure.
- **Pre-create / Observe** — only for a real bootstrap identity problem (a Function whose ARN is
  needed by a dependency cycle). Financial resources do not need them; there is nothing to stub
  before the real object exists.
- **Reconcile** — converges actual cloud state to desired state for every starting point.
- **Delete** — idempotent; a missing object is not an error. For financial records delete is
  retention or archival, never destruction (ADR 0003).
- **List** — enumerates every object in the scope for account-wide teardown, returning the same
  attributes `read` does. A resource that cannot meaningfully be deleted sets
  `nuke: { skip: true }`.

### Reconciler doctrine

`reconcile` receives `output` and `olds`:

| `output` | `olds` | Meaning |
| --- | --- | --- |
| `undefined` | `undefined` | Greenfield — no prior physical resource |
| defined | defined | Routine update — engine-owned resource |
| defined | `undefined` | Adoption — engine-owned through `read` |

It must work for all three. Do not branch the body on `output === undefined` and run a “create
body” versus an “update body”; that is rename-and-branch and re-introduces every assumption the old
create/update split made. Write one flow:

1. **Observe** — derive the physical identifier and read live cloud state via `getX` / `describeX`.
2. **Ensure** — if the resource is missing, create it. Catch `AlreadyExists` / `Conflict` as a race
   and continue. Wait for active state if the vendor has one.
3. **Sync** — for each mutable aspect (settings, sub-resources, tags, policy): read *observed* cloud
   state, compute desired state from `news`, diff, and apply only the delta. Skip the API entirely
   when there is no change.
4. **Return** — re-read the final state if needed and return fresh attributes.

Invariants:

- **Observation beats assumption.** Cloud state is authoritative; `olds` is at most a hint to skip
  a no-op call, never the source of truth for what is deployed.
- **Each sync step is independently idempotent.** Crash mid-reconcile, re-run, converge.
- **`output` is a cache** for stable identifiers (physical name, ARN, immutable id). It is not proof
  the object still exists; if it does not, observation falls through to “missing” and ensure
  recreates it.
- **Catch the races.** `AlreadyExists` / `NotFound` / `ResourceInUse` are races or eventual
  consistency, not failures to propagate.
- **Tags diff against observed tags.** Adoption may hand you an object whose tags do not match what
  was last persisted.

The canonical reference reconcilers live in the Alchemy mirror under
`.agent_sources/github.com/alchemy-run/alchemy/packages/`:
`aws/src/S3/Bucket.ts`, `aws/src/SQS/Queue.ts`, `aws/src/DynamoDB/Table.ts`, `aws/src/EC2/Vpc.ts`
and `cloudflare/src/Workers/Worker.ts`. Read one before writing a new lifecycle.

### Ownership, adoption and identity

- **Brand the object.** Stamp `createInternalTags(id)` on every resource, mapped to the vendor's
  metadata constraints; ours lives in each vendor package's `Metadata.ts` (`alchemy::stack` →
  `alchemy_stack`, and so on).
- **Diff with `diffTags` against observed metadata**, never `olds.tags` or `output.metadata`.
- **Refuse a foreign object.** `read` returns `Unowned(attrs)` when the object exists but lacks our
  ownership tags, so a deploy cannot silently take over a hand-made object.
- **The vendor id is a cache, not the identity.** Identity is the vendor's own field — a Stripe
  lookup key, a Polar `metadata.paykit_tier` plus a stage-qualified name — so a restored state
  reconciles to the same object instead of duplicating it.
- **Do not construct a name from randomness.** Derive it from the stack, stage and logical id, or
  from the catalog identity; a test must find the same object on every run.

### Props, attributes and JSDoc

- Props are plain types. **Never write `Input<T>` in a Props interface**; the engine applies
  `Input` deeply. `Input<T>` is only for a helper that genuinely receives unresolved values.
- A resource is `Resource<"Vendor.Resource", Props, Attributes, Binding, Providers>` and its
  contract and provider live in the same file. Attributes are plain data.
- Resource JSDoc uses `###` sections and `**Example:**` labels, with the generator tags last:
  `@resource` and `@product Product` on a resource, `@primitive` / `@product Stripe` on a helper,
  `@layer` on a provider layer. Every prop and attribute gets a field-level doc comment. The source
  is the docs source of truth.
- **Pure constructors, one validating Effect.** A declaration is total and side-effect-free; the
  effectful entry point maps schema failures to a tagged error with context.

### Resource tests

- Lifecycle and reconciliation use `test.provider` with `stack.deploy`: start and end with
  `stack.destroy()`, and exercise create, update, replacement and removal. A replace must prove the
  old object is retained or archived as the ADR says.
- Verify cloud state **out of band** through the vendor SDK, not from the provider's own attributes.
  Assert deletion (or archival) through the vendor too.
- Do not mock HTTP or SDK responses as a substitute for a deployment. A gated live test is the
  authority for the vendor path; a fast fake may sit beside it as a contract test, and must say so
  in its header.
- Use deterministic identities; never `Date.now()`, a UUID or a random suffix in a name. When a
  name is genuinely needed, derive it from `stack.stage`.
- Resource code and its tests follow the [Effect discipline](#effect-discipline) above: no
  `async` / `await`, raw `Promise`, `process.env`, `fetch` or `node:fs`.

## Source-first

Effect, Alchemy and Foldkit are read from source before their APIs are guessed. `pnpm
vendor:agent-sources` shallow-clones them under `.agent_sources/github.com/<owner>/<repo>/` at
the refs their catalog pins name, and writes `.agent-source.json` metadata beside each clone.
Read the installed `packages/*/node_modules/effect/AGENTS.md` first when it exists: it ships with
the version, so it is never stale. Then the mirrors:

| Mirror | Read for |
| --- | --- |
| `.agent_sources/github.com/Effect-TS/effect/` | Effect v4 Schema, Context.Service, Config, platform, SQL, tests |
| `.agent_sources/github.com/alchemy-run/alchemy/` | resources, Cloudflare and Stripe providers, Stack API |
| `.agent_sources/github.com/foldkit/foldkit/` | Foldkit UI, effects and subscriptions |

```sh
pnpm vendor:agent-sources                        # clone the missing mirrors
./scripts/vendor-agent-sources.sh --refresh      # re-clone at the current pins
```

Refs are derived from the catalog in `pnpm-workspace.yaml`, so a bump and a re-run stay matched;
the script fails when a pin has no upstream tag or a mirror's version disagrees with its pin.
Inventory and rationale live in [`.agent_sources/README.md`](./.agent_sources/README.md).

Mirrors are reference material, never runtime dependencies: they are gitignored and excluded
from typecheck, lint and format. Do not import from them and do not commit them.

## Gates

Before you commit: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm spec`, `pnpm test`,
`pnpm build`. The first four never compile `lib/`; `pnpm build` and `node scripts/smoke-artifact.mjs`
are what prove a published artifact loads.

`pnpm spec` model-checks the TLA+ models in [`spec/`](./spec) with `tla-ts`. They cover what a test
cannot: interleavings across writers, deadlines, the outbox and a crash. A model that has never been
made to fail is a model nobody has tested, so every config carries the constant that flips it into
the broken design; see [`spec/README.md`](./spec/README.md). A counterexample trace is a test's
setup — when a model finds something, reproduce it under `packages/paykit/test/` rather than leaving
it in the model.

`.github/workflows/check.yml` runs all seven on every push and pull request, and is modelled on
alchemy's `check.yml`: one job, steps in the order that makes each later step meaningful, every
action pinned to a commit rather than a tag, and `cancel-in-progress` only for pull requests.
`.github/workflows/release.yml` is a manual run on `main` that re-runs the gates, bumps the shared
version (`scripts/release/bump.ts`), packs both tarballs, and publishes with provenance only when
`dry-run` is off. Run
`pnpm exports:check` and `pnpm validate:publish-packages` when you move a module out of `src/`,
touch an export map, or bump a version. Formatting is fixable in place (`pnpm format`,
`pnpm lint:fix`); the type check, the tests and the manifest gates are not. If a gate is missing,
add it; if a gate fails, fix the code rather than the gate.

## Commits and PRs

- Conventional commit titles, scoped to the package: `feat(paykit): record usage in the same
  transaction that checks the allowance`.
- PR body starts with plain prose, then snippets or bullets. `###` is the deepest heading —
  never `#`/`##` in a description, and never a heading repeating the PR title.
- Prefer a snippet over a paragraph explaining it, and omit a "Test plan" section entirely.
- Outstanding work means: mark the PR draft and say what is missing in the chat that opened it.

## Further reading

- [What to build next](./docs/NEXT.md) — the state of the work, the queue, the traps, and the
  invariants a next slice must not break.
- [ADRs](./docs/adr/) — decisions that shaped the model, oldest first. Read
  [0001](./docs/adr/0001-catalog-states-the-pricing-model.md) before changing what the catalog can
  express: it is the record that says pricing is catalog data and the deploy provisions the vendor.
  [0006](./docs/adr/0006-postpaid-usage-is-a-unit-price-in-the-catalog.md) is the one to read before
  touching `unitPrice`, `moneyCap` or `UsageRecorded.charge`.
- [Alchemy AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md) — engine
  concepts, the Reconciler doctrine, the Typed Error Doctrine and the binding conventions every
  provider package here follows.
- [Alchemy source mirror](./.agent_sources/github.com/alchemy-run/alchemy/) — once vendored
  (`pnpm vendor:agent-sources`), the pinned source behind
  [Alchemy API conventions](#alchemy-api-conventions):
  `packages/alchemy/src/{Resource,Input,Contributions}.ts`,
  `packages/domain/src/{Command,Event,Rejection}.ts`, `packages/stripe/src/Price.ts`.
