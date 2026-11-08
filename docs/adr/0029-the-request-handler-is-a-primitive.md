# 0029 — The request handler is a primitive, so the path table is written once

- **Status:** Accepted
- **Date:** 2026-11-08
- **Follows:** [0015](./0015-a-runtime-binding-names-a-command.md), [0007](./0007-outbound-events-are-a-policy-over-a-port.md)

## Context

The configuration brief landed three one-call surfaces: `Paykit.BillingStack` validates and records a
catalog, `Paykit.world` builds the runtime graph, and `PaykitAtom.make` builds the browser client.
[The brief](../briefs/billing-configuration.md) names what is left, and one of them is
`Paykit.handler`.

Everything between `world` and a served request is still the deployment's own file. Across the five
examples that file is 582 lines, and the same five branches appear in four of them:

```
/api/*      → BillingApi.fetch
/admin/*    → BillingAdminApi.fetch
/checkout   → the Subscribe binding, account and tier from the request
/webhooks/* → the provider's decoder, then Paykit.Webhook
```

The pieces under those branches are already paykit's: `Paykit.Subscribe`, `Paykit.Webhook`,
`Paykit.httpStatus`. What is not is the table that wires them, so each example re-derives it — and
`moneyRoutes`, the checkout/webhook pair, is copied verbatim into
`examples/billing/src/Billing.ts` and `examples/polar/src/Billing.ts`.

Duplication in an example is a documentation bug with a compiler: the five examples are the
advertised usage, and a reader copies whichever one they opened. It is also where a deployment gets
the security-shaped parts wrong. A handler that mounts `/webhooks` before verifying the signature, or
that answers 500 for a refusal, is a handler somebody wrote by hand.

## Decision

**1. `Paykit.handler({ … })` returns the request function, and it builds no world.** The signature is
a function of the request:

```typescript
const handle = Paykit.handler({ provider, surfaces: "both" });
// (request) => Effect<HttpServerResponse, never, BillingApi | BillingAdminApi>
```

It requires `BillingApi` and `BillingAdminApi` and never constructs them. That is the rule the billing
example already states in a comment — "every service this reaches is resolved from the world `serve`
provides, so a route cannot answer from a second copy of the model" — promoted to the type. A host
whose bindings are per-request (a D1 binding only exists inside a request) keeps
`Effect.provide(world)` at the call site, where it already is.

**2. The mounts are options; the defaults are the four paths every example uses.** `tenant` and
`admin` default to `/api` and `/admin`, `checkout` to `/checkout`, `webhooks` to `/webhooks`; a
deployment behind a prefix moves them without re-deriving the table. `surfaces` picks which of the
two Api mounts exist, because a Worker that serves only the console should not answer `/api`.

**3. `routes` is the escape hatch, tried first.** A deployment's own paths — the tanstack example's
`/`, the billing example's `/mcp` — are `{ path, handle }` entries matched before the built-ins. This
is what keeps the primitive honest: it owns the table it can own, and gives back the branch it cannot.

**4. `Paykit.moneyRoutes(provider)` is promoted beside it.** The checkout and webhook pair is
paykit's logic with a provider plugged in, and it is already duplicated across two examples.
`handler` uses it, so a deployment that mounts its own paths gets the same pair rather than a copy of
it.

**5. A refusal is answered by `Paykit.httpStatus`, not by the deployment.** Both `/checkout` and
`/webhooks` currently map a typed failure to a status in the example. The handler does it, so the four
examples cannot disagree about what a `TierNotInCatalog` or a spent `RefundExceedsCharged` answers.

## Consequences

- An example's `Worker.ts` becomes the Worker's own concerns: the binding, the world, and the paths
  paykit does not know about.
- `moneyRoutes` has one definition rather than two, and the two examples that had it keep working by
  importing it.
- The handler is a function, not a Layer, so it composes with the existing one-handler-per-Worker
  shape and needs no change to `World.ts`.
- A deployment that wants a different status for a refusal can still write its own route: `routes`
  runs first, so nothing is forced.
- The handler does not know about MCP, Better Auth, or a console's forwarding Worker. Those stay in
  the examples, which is the point of the escape hatch rather than a gap in it.

## Alternatives considered

- **A `Paykit.Worker` Alchemy resource that owns the fetch handler.** It would fold the world into the
  resource's props, which is the shape `BillingStack` already has. Rejected because the world is a
  Layer the deployment composes (`platform`, `readStore`, `guards`, `providers` are all layers), and
  a resource would have to re-expose every one of them as a prop to stay configurable. The handler is
  the part that is identical; the world is the part that is not.
- **A handler that builds the world from options.** It reads better in a one-line example and it
  breaks the per-request binding case, which is every Cloudflare deployment with D1.
- **Leave it in the examples.** Then five files keep their own copy of a security-shaped table, and
  the sixth deployment to be built copies whichever it finds.

## What would reopen this

- A surface that is paykit's but not an Api — an MCP server derived from the tenant Api. That is
  `DomainAi.toMcp`'s job, and it would arrive as a mount option beside `checkout`, not as a branch in
  an example.
- A deployment that needs two providers in one handler: `moneyRoutes` would take the router rather
  than one provider, and `handler` would route by tier rather than by path.
