---
title: "Handler"
description: "Exports `moneyRoutes`, `handler`."
---

> **Source:** [`packages/paykit/src/Handler.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Handler.ts#L27)

## moneyRoutes

> **Kind:** Primitive

The two money paths as a binding, the way every other paykit primitive is
built: the services resolve once, at the edge, and each request is a call
into the captured bindings. Pure in the provider, so a test can hand it one
that needs no key.

`Paykit.handler` uses it; a deployment that mounts its own paths gets the same
pair rather than a copy of it, which is what happened in two examples before
ADR 0029.

### Selling a tier and applying a delivery

```typescript
const routes = yield* Paykit.moneyRoutes(Provider);

const purchase = yield* routes.purchase(account, "pro");
const applied = yield* routes.deliver({ headers: request.headers, body });
```

## handler

> **Kind:** Primitive

The built-in paths every paykit deployment serves, as one request handler.

The handler builds no world: it requires `BillingApi` and `BillingAdminApi`
and never constructs them, so the process that provides the world is the one
that answers, and a route cannot serve a second copy of the model. A host
whose bindings exist only inside a request — a D1 binding, on Cloudflare —
keeps its `Effect.provide` at the call site.

A refusal answers `Paykit.httpStatus`, so the examples cannot disagree
about what a `PlanNotInCatalog` or a spent `RefundExceedsCharged` returns. A
delivery answers 202 whether or not it recorded anything, because a provider
should not retry an event paykit does not model.

The result is both a request function and an `HttpEffect` (`handler.fetch`),
the shape Alchemy's Better Auth integration uses for `auth.fetch`: a Worker
whose world it can build once returns `{ fetch: handler.fetch }`, and one
whose world exists only inside a request calls `handler(request)` with the
world provided there.

### A Worker's paths

```typescript
const BillingLive = Paykit.world({ catalog, providers: [Provider], guards });

export default class BillingWorker extends Cloudflare.Worker<BillingWorker>()(
  "BillingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const handler = yield* Paykit.handler({
      provider: Provider,
      accountOf: (request) => Paykit.accountFromHeaders(request.headers),
    });

    return { fetch: handler.fetch };
  }).pipe(Effect.provide(BillingLive)),
) {}
```
