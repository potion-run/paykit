---
title: "fromAuthProvider"
description: "Build a Polar Credentials layer that resolves credentials via the Alchemy AuthProvider using the configured profile (defaults to default, overridable with the ALCHEMY_PROFILE env/config value)."
---

> **Source:** [`packages/paykit-polar/src/Credentials.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/Credentials.ts#L15)
> **Kind:** Layer · **Product:** Polar

Build a Polar `Credentials` layer that resolves credentials via the Alchemy
AuthProvider using the configured profile (defaults to `default`, overridable
with the `ALCHEMY_PROFILE` env/config value).

Maps onto `@distilled.cloud/polar`'s `{ apiKey, apiBaseUrl }` shape.
Distilled's `Credentials` service is an `Effect<Config>` resolved per
request. Environment credentials (`POLAR_API_KEY`) take precedence; otherwise
the selected profile is used.

`baseUrl` is the deployment's server choice: when it is given, it wins over
the token's stored base URL, so `polarProviders({ server: "sandbox" })`
always points a token at the sandbox.

## Resolving the deploy's token

```typescript
const credentials = fromAuthProvider({ apiBaseUrl: "https://sandbox-api.polar.sh" });
```
