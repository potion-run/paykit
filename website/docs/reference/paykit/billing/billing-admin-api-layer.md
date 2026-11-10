---
title: "BillingAdminApiLayer"
description: "Every operator binding, implemented over BillingAdminApi — the Api whose commands declare Admin, so a tenant session cannot reach one."
---

> **Source:** [`packages/paykit/src/Billing/BillingAdminApi.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/BillingAdminApi.layer.ts#L27)
> **Kind:** Layer · **Product:** Console · **Provides:** `Paykit.GrantCredits`

Every operator binding, implemented over `BillingAdminApi` — the Api whose
commands declare `Admin`, so a tenant session cannot reach one.

Protocol-agnostic, like the tenant layer: resolve `BillingAdminApi.Client` and
the deployment chooses `layerClientInProcess` or `layerClientHttp(url)`. The
caller comes from [BindingCall](/reference/paykit/billing/bindings), which a console backend provides from
its own operator session.

## Providing the console from another service

```typescript
const Ops = Layer.provide(
  BillingAdminApiLayer,
  BillingAdminApi.layerClientHttp(env.BILLING_ADMIN_URL),
);
```
