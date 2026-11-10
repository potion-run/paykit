---
title: "polarProviders"
description: "Register the Polar provider a stack needs to reconcile PolarPrices."
---

> **Source:** [`packages/paykit-polar/src/Providers.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/Providers.ts#L24)
> **Kind:** Layer

Register the Polar provider a stack needs to reconcile `PolarPrices`.

A deployment writes the token once, beside its other providers:

```typescript
export default Alchemy.Stack("App", {
  providers: Layer.mergeAll(polarProviders({ accessToken }), Cloudflare.providers()),
  state: Alchemy.localState(),
}, program);
```
