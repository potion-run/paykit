# @potion.run

The repo that publishes every `@potion.run` package, the way the Alchemy repo publishes `alchemy`
and `@alchemy.run/*`. Each package is built on Alchemy and Effect and carries its own doctrine
beside its source.

## Packages

| Package | Directory | What it is | Read next |
| --- | --- | --- | --- |
| `@potion.run/paykit` | `packages/paykit` | Billing and entitlement for Alchemy | [AGENTS.md](./packages/paykit/AGENTS.md) · [PLAN.md](./packages/paykit/PLAN.md) |
| `@potion.run/paykit-polar` | `packages/paykit-polar` | Polar provider for Alchemy, usable without paykit | [AGENTS.md](./packages/paykit-polar/AGENTS.md) |

A new package is `packages/<name>`, named `@potion.run/<name>`. Give it an `AGENTS.md` when it
carries rules a reader needs before touching it, and add it to the workspace globs and the root
`tsconfig.json` project references in the same commit.

## Repo rules

- **One scope.** Every published package is `@potion.run/<name>`. Nothing unscoped, nothing under
  a second scope.
- **One version line.** Packages share a version and release together, like Alchemy's
  `2.0.0-beta.N`. Internal dependencies are `workspace:*`, and an optional peer pins the
  matching range, so two packages never drift.
- **The root does not publish.** Root `package.json` holds scripts and dev dependencies;
  `packages/*` publishes, while `examples/*`, `website/*` and `docs/*` do not.
- **Project references.** Each package owns a `tsconfig.json` and a `tsconfig.test.json`; the
  root one references them all. `pnpm typecheck` is `tsrs -b` over that graph, so a change in one
  package cannot land with a broken consumer.
- **Tests live with the package.** `pnpm test` fans out. A package with no tests is not done.

## Tooling

- **pnpm 12** with one catalog in `pnpm-workspace.yaml`. A package declares `catalog:`, never a
  version; the catalog is the only place a version is written.
- **tsrs** compiles the type graph (`pnpm typecheck`), with `tsc` as the reference compiler where
  tsrs ships no binary. `scripts/build-package.ts` runs `tsrs -b --force` for `pnpm build`.
- **oxlint** (`pnpm lint`) runs type-aware rules; **oxfmt** (`pnpm format`) formats source and
  `package.json`, and `pnpm format:check` is the gate. The pre-commit hook runs the formatter.
- **alchemy-test** (`@alchemy.run/test`) runs each package's `test/*.test.ts` under Bun.
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

Before you commit: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. Formatting
is fixable in place (`pnpm format`, `pnpm lint:fix`); the type check and tests are not. If a gate
is missing, add it; if a gate fails, fix the code rather than the gate.

## Commits and PRs

- Conventional commit titles, scoped to the package: `feat(paykit): record usage in the same
  transaction that checks the allowance`.
- PR body starts with plain prose, then snippets or bullets. `###` is the deepest heading —
  never `#`/`##` in a description, and never a heading repeating the PR title.
- Prefer a snippet over a paragraph explaining it, and omit a "Test plan" section entirely.
- Outstanding work means: mark the PR draft and say what is missing in the chat that opened it.

## Further reading

- [Alchemy AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md) — engine
  concepts, the Reconciler doctrine, the Typed Error Doctrine and the binding conventions every
  provider package here follows.
- [Alchemy source mirror](./.agent_sources/github.com/alchemy-run/alchemy/) — once vendored
  (`pnpm vendor:agent-sources`), the pinned source behind
  [Alchemy API conventions](#alchemy-api-conventions):
  `packages/alchemy/src/{Resource,Input,Contributions}.ts`,
  `packages/domain/src/{Command,Event,Rejection}.ts`, `packages/stripe/src/Price.ts`.
