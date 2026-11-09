# 0048 — The Api names a plan, and the deployment joins it

- **Status:** Accepted
- **Date:** 2026-11-14
- **Follows:** [0015](./0015-a-runtime-binding-names-a-command.md), [0028](./0028-a-browser-reads-the-catalog-from-the-deploy.md), [0041](./0041-a-custom-plan-is-a-catalog-opt-in.md), [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md)

## Context

`StartTrial`, `ScheduleTierChange`, a group cancellation and a controls write each carry a fact the
catalog owns: a plan's allowances, price, credits, rates and top-up line; a group's fallback plan; or
whether a feature is priced. `decide` is pure, so that fact has to travel on the command. The
bindings therefore joined it from `CatalogService` before sending.

For an in-process binding that is free. Over the tenant Api it meant every browser needed the
deployment's catalog before it could name a plan, and [ADR
0028](./0028-a-browser-reads-the-catalog-from-the-deploy.md) served that catalog over a guarded RPC
so the copy could not go stale. The read was correct, but it existed only to let the client do work
the deployment can do better.

A `Domain.Api` command cannot fix this. Its RPC payload is decoded and handed straight to
`decide`; middleware can validate the payload but cannot replace it. Enriching a command between
the wire and the model needs a different command surface, not another field on an existing one.

## Decision

**1. A tenant command surface expands a plan on the deployment.** `BillingCommandsRpcs` is an
Effect RPC group over four commands — `StartTrial`, `ScheduleTierChange`, `ScheduleCancellation` and
`SetBillingControls` — behind the same `Session` middleware as `BillingApi`. Its payload names the
account (`target`), the plan or group, and the caller's retry key. It never carries catalog terms.

**2. The join is a service the deployment provides.** `BillingCommands` is the service;
`BillingCommandsLive` implements it from `CatalogService`, `Subscription` and `BillingState`, and
`BillingCommandsClient` reaches it over the RPC group. The live implementation sends the same
commands the in-process bindings send, with the same catalog builders, and waits on the same view.
It is the server half of the join, not a second model.

**3. `BillingApiLayer` resolves that service instead of the catalog.** The four bindings call
`BillingCommands` and return its result. They no longer read `CatalogService`, so a client that
speaks the Api and the command surface needs no catalog copy. The low-level `BillingApi` commands
still take their catalog fields: this decision changes who joins them, not what the model records.

**4. `Paykit.handler` mounts the surface.** It serves it at `${tenant}/commands` by default, before
the Api's prefix, and requires `BillingCommands` beside `BillingApi`; it still builds no world. A
deployment with its own path table mounts `Paykit.BillingCommandsServer` itself.

**5. `PaykitAtom.make({ url })` reads no catalog.** It builds the Api client and the command client
and nothing else. `PaykitCatalogClient` remains a guarded read for a deployment or tool that wants
the catalog; the join no longer depends on it.

## Consequences

- **The browser cannot join stale terms.** There is no client copy to go stale, so the failure
  `CatalogMismatch` used to report for a stale bundle is no longer reachable through these verbs.
- **The deployment owns the definition of a plan.** A command's plan id is resolved against the
  catalog the model was built with, which is the catalog `CatalogGuard` checks it against.
- **The in-process bindings do not change.** They keep their bodies and their behavior; the new
  service is what an Api client resolves.
- **A custom plan still states its bespoke terms.** `grants` and a negotiated `price` are the
  caller's, not the catalog's, so the command surface carries them exactly as the binding did.
- **A direct `Domain.Api` caller still supplies the terms.** The advanced commands remain the
  low-level surface; a caller that bypasses `BillingCommands` is the one that must hold a catalog.
- **The catalog route is no longer required by the atom client.** A deployment may keep it for its
  own tools, but it is not on the path of a trial or a scheduled change.

## Alternatives considered

- **Let `CatalogGuard` fill the command.** It runs after decoding and before `decide`, but a
  middleware cannot change a command's payload; accepting a thin payload there would move a catalog
  read into the decision path or create a second validation rule.
- **Keep the browser copy, and accept drift.** ADR 0028 already rejected that: the failure is a
  build-to-build difference no page can explain.
- **Put the catalog on the wire.** That is the same drift in a larger payload, and it puts pricing
  in every command instead of in the deployment that validated it.

## What would reopen this

- A generated client that calls `BillingCommands` from a surface with no session cookie: the
  command client would need the deployment's own auth propagation, not a second payload.
- A menu of plan terms a client must render before naming one: that is a catalog read, and
  `PaykitCatalogClient` is still the guarded answer.
