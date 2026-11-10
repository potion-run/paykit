---
title: "world"
description: "One deployment graph, built from the parts a host chooses."
---

> **Source:** [`packages/paykit/src/World.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/World.ts#L201)
> **Kind:** Primitive

One deployment graph, built from the parts a host chooses.

The model is the centre: the catalog guard, the read store, the platform and
the provider router are provided to it, and the tenant and operator bindings
are provided from it. A caller that provides this layer can send exactly the
commands the chosen bindings serve, and a test, an example and a Worker differ
only in the options — the graph is the same one.

The catalog and every declared provider mapping are validated here, in the
layer's error channel: a catalog that does not decode, a provider price that
disagrees with it, two providers that share a name, or — when the world
declares providers — a priced tier none of them can sell refuses the build. A
local-only world with no providers and a pre-built `payments` fake are the two
exemptions: neither is a deployment, so there is nothing to prove sellable. A
deploy validates the same declaration with `Paykit.BillingStack`; a runtime
that cannot decode it is a defect the host handles once, at its boundary,
instead of an `Effect.runSync` that throws at module load.

The store is provided both to the handlers and outward, because `List` reads
the projection directly rather than through a view. A single provider's built
services are merged too — the same context a command resolves, not a second
build — so a route beside the world can call `Payments`; with two providers
the router is the only answer, because merging both would shadow one by merge
order.

A tier's `topUp` line is catalog data, but the policy that acts on it is the
deployment's: `autoTopUp` installs it and names the pack a line without one
buys. Omitted, a crossing records nothing and the line is inert.

## A Worker's world

```typescript
const World = Paykit.world({
  catalog: billingCatalog,
  platform: DomainCloudflare.layerDurableObjects(),
  guards: CookieGuards,
  providers: [Provider],
  bindings: "both",
});
```
