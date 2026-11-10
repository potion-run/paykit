---
title: "polarProviders"
description: "Register the Polar provider a stack needs to reconcile PolarPrices."
---

> **Source:** [`packages/paykit-polar/src/Providers.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/Providers.ts#L30)
> **Kind:** Layer

Register the Polar provider a stack needs to reconcile `PolarPrices`.

The access token is resolved by the Alchemy AuthProvider: `POLAR_API_KEY`
from the environment wins, otherwise the profile `ALCHEMY_PROFILE` selects
(default `default`). A deployment writes it once, in the environment or in
`alchemy profile edit --provider Polar`, beside its other providers:

```typescript
export default Alchemy.Stack("App", {
  providers: Layer.mergeAll(polarProviders({ server: "sandbox" }), Cloudflare.providers()),
  state: Alchemy.localState(),
}, program);
```

`server` or `baseUrl` is the deployment's choice, not a credential: when one
is given it overrides the stored base URL, so a sandbox deploy cannot be
pointed at production by a profile.
