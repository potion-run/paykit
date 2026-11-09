# 0028 — A browser reads the catalog from the deploy

- **Status:** Accepted; decision 3 is superseded by [0048](./0048-the-api-names-a-plan-and-the-deployment-joins-it.md)
- **Date:** 2026-11-07
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0003](./0003-the-deploy-provisions-the-vendor.md), [0026](./0026-a-tier-states-its-whole-top-up-line.md)

## Context

[The configuration brief](../briefs/billing-configuration.md) collapsed a deployment to one
`billing.config.ts` and three one-call surfaces. One of them, `PaykitAtom.make({ url, catalog })`,
made the browser import that same module — so the catalog was bundled a second time, into a second
process, with a second lifetime.

Two copies of a pricing catalog are a drift hazard, and the failure it produces is unreadable:

- **A stale asset.** The Worker redeploys with a new price; a browser still holding the old bundle
  joins the old price onto a `StartTrial`. The Api's `CatalogGuard` refuses it with `CatalogMismatch`
  — correctly, since it would otherwise record a standing nobody sold — and the page shows nothing
  an operator can act on, because the page believes its own copy.
- **A partial deploy.** One Worker is ahead of another, or one stage's asset is cached. The same
  `CatalogMismatch`, with no way to tell "your build is old" from "your deploy is wrong".
- **A second validation.** `make` validated the imported catalog in the browser, on the boot path of
  a page render, for a value the deploy had already validated at build time.

The brief named the fix as its own decision: "Moving `StartTrial` and `ScheduleTierChange`'s join
server-side would remove the last catalog copy from the browser. That changes what the Api serves, so
it is an ADR of its own."

## Decision

**1. The deploy serves its catalog, guarded, as its own read.** `PaykitCatalogRpcs` is an RPC group
with one op, `Catalog`, behind the tenant `Session` guard:

```ts
export const PaykitCatalogRpcs = RpcGroup.make(
  Rpc.make("Catalog", { success: Catalog }),
).middleware(Session);
```

`PaykitCatalogServer` builds the handler from `CatalogService` — the same value the model was built
with — so what a browser joins is by construction the catalog the guard compares against.
`PaykitCatalogClient(url)` reads it once and provides it as `CatalogService`.

**2. `PaykitAtom.make({ url })` needs no catalog.** The `catalog` option stays for a consumer that
already holds the value — a Worker sharing the deploy's config module, or a test — and is omitted in
a browser. Omitted, `make` reads `${url}/catalog` (or `catalogUrl`) when the runtime is built. The
served value is validated on arrival too, so a deploy serving a catalog this build cannot read fails
at build with `CatalogError` rather than at the first command.

**3. The join stays where it is.** `StartTrial` and `ScheduleTierChange` still join a tier's terms on
the client. Moving *that* server-side needs the Api to accept a tier id and a server-side step to
expand it, and `@alchemy.run/domain` runs a command's declared input straight into `decide`: there is
no hook between the RPC payload and the aggregate. The only place it fits is a custom RPC group over
the model's commands — the shape `AdminChangeTierRpcs` already uses for admin work — which is a
second tenant command surface, not a config change. That is `Paykit.handler`'s decision, and this
slice does not pre-empt it.

**4. The read is not public.** A catalog is pricing, not entitlement state, but it is still a
signed-in read: serving it anonymously would let a caller enumerate a deployment's tiers, prices and
top-up lines without an account. The `Session` guard is what a `BillingApi` read already carries, so
the cost of the rule is zero.

## What this does not decide

- **`Paykit.handler`.** One call that serves `/api`, `/admin`, `/catalog` and `/webhooks` from a
  deployment's config is the natural home for this route, and it is a surface, not a config
  primitive. Until then a deployment mounts `PaykitCatalogServer` itself.
- **A catalog read for update streams.** A deploy that changes prices while browsers hold a runtime
  does not push the new value: `make` reads once, at build. A live catalog feed is a subscription,
  with its own question about what a page should do when a price moves under it.
- **Typed tier ids at the boundary.** Unchanged from ADR 0015: a `tier` is a `string` at a binding.

## Consequences

- **A client cannot build without a session.** The read is guarded, so a runtime built before the
  user signs in fails with `Unauthenticated` at build rather than lazily. A page that mounts the
  client before sign-in must build it after, or pass `catalog` itself.
- **`BillingAtomClientError` is a named union** — `CatalogError | CatalogUnavailable | Unauthenticated
  | Forbidden` — so a caller of `make` sees every way building a client can fail, instead of
  discovering them at the first command.
- **A deployment gets one more route.** It is one line beside the Api's, and the examples that proxy
  `/api/billing/*` to the Billing Worker forward it unchanged.
- **`examples/tanstack` stops importing the catalog in the browser**, which is the proof: its
  `billing.atoms.ts` is now `PaykitAtom.make({ url })` and nothing else.

## Alternatives considered

- **Bundle it, and accept the drift.** `CatalogMismatch` is a real refusal that protects the log, but
  the failure it reports is a build-to-build difference no page can explain.
- **Serve it as a view.** A `Domain.View` is keyed, and the catalog is one value for the whole
  deployment: a view keyed by account would duplicate the catalog per account in every seat.
- **Serve it unguarded.** A catalog is what a deployment sells; a public listing of every tier, price
  and top-up line is a competitive artefact, not a marketing page.
- **Move the join into `decide`.** Refused by the invariant this package is built on: `decide` is
  pure, and the terms a standing was sold at travel on the command, the event and the state.

## What would reopen this

- `Paykit.handler`: the catalog route becomes a line in one call instead of a mount of its own.
- A live catalog feed: a subscription rather than a read, and the question of what a page does when
  a price it is showing moves.
- A tenant command surface that joins tiers server-side: the same decision `Paykit.handler` carries.
