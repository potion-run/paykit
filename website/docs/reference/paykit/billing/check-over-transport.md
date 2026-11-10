---
title: "CheckOverTransport"
description: "Check over a transport: delegate the question to whatever serves the entitlement elsewhere — an HTTP call, a Durable Object, another Worker's binding."
---

> **Source:** [`packages/paykit/src/Billing/CheckOverTransport.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/CheckOverTransport.layer.ts#L7)
> **Kind:** Layer · **Product:** Usage · **Provides:** `Paykit.Check`

`Check` over a transport: delegate the question to whatever serves the
entitlement elsewhere — an HTTP call, a Durable Object, another Worker's
binding. The deployment provides `CheckTransport`, so this layer holds no
opinion about how the answer travels.

The transport answers `CheckResult` already, so no `evaluateCheck` runs here:
the remote side made the judgement with the same function and the same view.
