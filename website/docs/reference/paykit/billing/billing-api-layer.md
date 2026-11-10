---
title: "BillingApiLayer"
description: "Every paykit tenant binding, implemented over BillingApi — the Api's own Session middleware decides whether this caller may act for this account, and its reply decoding turns a rejection back into the class a caller matches."
---

> **Source:** [`packages/paykit/src/Billing/BillingApi.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/BillingApi.layer.ts#L736)
> **Kind:** Layer · **Product:** Usage · **Provides:** `Paykit.TrackUsage`, `Paykit.Check`, `Paykit.Hold`, `Paykit.SettleHold`, `Paykit.ReleaseHold`

Every paykit tenant binding, implemented over `BillingApi` — the Api's own
`Session` middleware decides whether this caller may act for this account,
and its reply decoding turns a rejection back into the class a caller
matches.

The layer is **protocol-agnostic**: it resolves `BillingApi.Client` for the
commands the Api serves directly, and `BillingCommands` for the four whose
catalog terms the deployment joins. The deployment picks the protocol beside
each.

```typescript
Layer.provide(BillingApi, BillingApi.layerClientInProcess)          // same host
Layer.provide(BillingCommands, BillingCommandsLive)                 // same host
Layer.provide(BillingApi, BillingApi.layerClientHttp(url))          // another service
Layer.provide(BillingCommands, BillingCommandsClient(`${url}/commands`))
```

Read-your-write survives the transport: every verb reads `Entitlements` with
`atLeast` the receipt it just committed, exactly as the in-process layer waits
on the view, so a `Check` straight after a `TrackUsage` sees it on either.
