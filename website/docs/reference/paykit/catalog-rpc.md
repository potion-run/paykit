---
title: "CatalogRpc"
description: "Exports `PaykitCatalogRpcs`, `PaykitCatalogClient`."
---

> **Source:** [`packages/paykit/src/CatalogRpc.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/CatalogRpc.ts#L15)

## PaykitCatalogRpcs

> **Kind:** Primitive · **Product:** Pricing

The catalog the deploy sells, served to a signed-in caller.

It exists so a browser joins a tier's terms from the deployment's own
catalog instead of a bundled copy. Two copies are a drift hazard: a stale
asset would send terms the server's `CatalogGuard` refuses with
`CatalogMismatch`, which is a failure nobody looking at the page can explain.
Served, what a client joins is by construction the value the model was built
with.

### Serving the catalog beside the tenant Api

```typescript
const api = yield* BillingApi;
const served = yield* PaykitCatalogServer;

fetch: Effect.gen(function* () {
  const url = new URL((yield* HttpServerRequest).url, "http://billing");
  if (url.pathname.startsWith("/api/billing/catalog")) return yield* served;
  return yield* api.fetch;
})
```

## PaykitCatalogClient

> **Kind:** Layer

Read the deploy's catalog once and provide it as `CatalogService`.

Provide an `HttpClient` (for a browser, `FetchHttpClient.layer`); a
same-origin session cookie authenticates the call. The reply is validated on
arrival as well as on the server, so a deploy serving a catalog this build
cannot read fails here rather than at the first command that joins a tier.
