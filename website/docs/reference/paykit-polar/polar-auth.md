---
title: "PolarAuth"
description: "Layer that registers the Polar {@link AuthProvider} into the {@link AuthProviders} registry."
---

> **Source:** [`packages/paykit-polar/src/AuthProvider.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/AuthProvider.ts#L62)
> **Kind:** Layer · **Product:** Polar

Layer that registers the Polar `AuthProvider` into the
`AuthProviders` registry. Include this in the Polar `providers()` layer
so the alchemy CLI can discover it.

Auth is a Polar access token (`POLAR_API_KEY`, from the dashboard). Polar has
no OAuth flow. An optional `POLAR_API_BASE_URL` overrides the API root
(default `https://api.polar.sh`); `polarProviders({ server: "sandbox" })`
overrides it to the sandbox host instead, so a production token cannot be
sent to the sandbox by accident.
