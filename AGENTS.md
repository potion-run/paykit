# @potion.run

The repo that publishes every `@potion.run` package, the way the Alchemy repo publishes `alchemy`
and `@alchemy.run/*`. Each package is built on Alchemy and Effect and carries its own doctrine
beside its source.

## Packages

| Package | Directory | What it is | Read next |
| --- | --- | --- | --- |
| `@potion.run/paykit` | `packages/paykit` | Billing and entitlement for Alchemy | [AGENTS.md](./packages/paykit/AGENTS.md) · [PLAN.md](./packages/paykit/PLAN.md) |
| `@potion.run/polar` | `packages/polar` | Polar provider for Alchemy | [AGENTS.md](./packages/polar/AGENTS.md) |

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
