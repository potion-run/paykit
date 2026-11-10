# 0050 — A host is an adapter, not a variant

- **Status:** Accepted
- **Date:** 2026-11-10
- **Amends:** [0049](./0049-the-billing-schema-is-a-description-and-the-deploy-converges-it.md)
- **Follows:** [0029](./0029-the-request-handler-is-a-primitive.md), [0049](./0049-the-billing-schema-is-a-description-and-the-deploy-converges-it.md)

## Context

The model, the stores and the bindings are Effect services. The first host is a Cloudflare Worker
built by Alchemy; a second host is wanted: one Node process, `node:http`, a long-lived SQL pool, no
deploy resource. The obvious framing — "an Effect version of paykit", published beside the existing
one — is the wrong one. It would fork the vocabulary, the version line and the package names, and it
would imply the existing package is not already Effect-native.

The database port had already started to make that mistake. `DatabaseService` carried a
`runtime: Effect<SqlExecutor, never, RuntimeContext | Scope.Scope>` field and an optional
`migrate` field in the same interface. `RuntimeContext` is Alchemy's ambient workerd binding
context: a Node process has no such service, and a target that cannot migrate has no deploy
connection. One interface therefore described two planes — what a request needs, and what a deploy
needs — and named a platform in the request half.

## Decision

**1. The model is one; the edge varies.** "Effect" is the substrate, not a flavour. A second
process is a **host**, and a host is an adapter around the same model, catalog, commands and ports.
There is no `paykit-effect`, `paykit-native` or `paykit-core`; `paykit` stays the model, and a host
package is named after where it runs (`paykit-node`, and `paykit-cloudflare` only if the Worker
adapter ever leaves the barrel).

**2. A host package is the unit of support, not the unit of code.** `@potion.run/paykit-node`
depends on `@potion.run/paykit` (`workspace:*`), never the reverse, shares the version line, and
carries its own optional peers (`@effect/platform-node`, `pg`, `mysql2`). The core package never
imports a runtime driver at its barrel and never grows a `node` export condition: conditions resolve
modules, not platforms, so Node uses `default` and the Worker uses `worker`. A host exports host
words (`serve`, `host`, `run`), never a second `Database` or `Postgres`; one name keeps one owner.

**3. A host earns a package only when it has a lifecycle.** `HttpServer.serve(handler.fetch)` is
already ten lines on Node, so the first proof is `examples/node`, not a published package. A package
exists when the host owns something the core cannot: a process-scoped pool, signals and drain, a
boot-time migration, configuration. Until then the package name is a promise with no code behind it.

**4. The database port is split by plane, not by platform.** `DatabaseService` is the runtime half
and imports only `effect`:

```ts
interface DatabaseService {
  dialect: SqlDialect;
  schema?: string;
  executor: Effect<SqlExecutor, never, Scope.Scope>;
}
```

`executor` is acquired on the caller's scope: a Worker scopes it to the request, a Node process
scopes it to the process. The lifetime is the scope's, so the port does not name a platform and no
caller provides `RuntimeContext`. The deploy half is a separate service, `DatabaseMigrate`, with the
identity and two-stage connection [ADR 0049](./0049-the-billing-schema-is-a-description-and-the-deploy-converges-it.md)
described. A layer provides it only when the target can migrate; a runtime host reads it with
`Effect.serviceOption`, so absence is the normal `Memory`/`Drizzle({ migrate: false })` case and not
a lie in the layer's type. An adapter that genuinely needs bindings — D1 — keeps `RuntimeContext`
inside itself, where the host provides it.

**5. The deploy API keeps its shape.** `BillingStack({ migrate })` still decides from the presence
of a `Database` layer and probes `DatabaseMigrate`; `registerMigrations` still owns only `Database`.
A Node host therefore provides the same layers, at a wider scope, and deployment code does not
branch on the host.

## Consequences

- `DatabaseService.runtime` is renamed to `executor`; the deploy support is exported as
  `DatabaseMigrate` (tag) and `DatabaseMigrateService` (type). ADR 0049's interface is amended in
  place by this decision; the old text is not rewritten.
- The Host guard is an example: `examples/node` serves `Paykit.handler` over `NodeHttpServer` with a
  memory store, so the port's scope lifetime is demonstrated without a database. A pool-backed Node
  host is the same file with `Postgres(...)` provided on the process scope.
- A future `paykit-node` adds `serve`/`host` only. If it ever needs database lifecycle of its own, it
  provides `Database` under a process scope; it does not add `NodePostgres`, because that would be a
  second name for one target.
- The Worker adapter keeps `RuntimeContext` inside `Database/D1`; the port does not leak it to the
  model, the tests or a Node consumer.
