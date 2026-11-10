---
title: "BillingInProcess"
description: "Every paykit binding, implemented in the process that hosts the model."
---

> **Source:** [`packages/paykit/src/Billing/BillingInProcess.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/BillingInProcess.layer.ts#L1207)
> **Kind:** Layer · **Product:** Usage · **Provides:** `Paykit.TrackUsage`

Every paykit binding, implemented in the process that hosts the model.

One layer for the whole tenant surface, because the clearance is the Api's and
not the operation's: a deployment that provides this layer can send exactly the
commands `BillingApi` serves, and nothing an operator can.

Provide it beside the store, the catalog and the payments router. Swap it for
`BillingApiLayer` to host the model in a different service — no call site
changes.

## Providing the tenant surface

```typescript
const World = Layer.mergeAll(BillingInProcess, catalogLayer(Catalog), provider.payments);

fetch: Effect.gen(function* () {
  const trackUsage = yield* Paykit.TrackUsage(account);
  yield* trackUsage({ featureId: "messages", value: 1, idempotencyKey: requestId });
});
```
