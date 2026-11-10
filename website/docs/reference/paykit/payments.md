---
title: "Payments"
description: "Exports `providerSet`, `resolveProvider`."
---

> **Source:** [`packages/paykit/src/Payments.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Payments.ts#L366)

## providerSet

> **Kind:** Primitive

The set, with every provider's services built once, in the caller's scope.

An `Effect` because building a provider's layer acquires whatever that layer
acquires. The world builds this once, so a provider's client lives as long as
the world does — for a Worker that builds its world per request, that is the
request; for a process that builds it once, the process.

### Building a set

```ts
const set = yield* providerSet([Stripe({ ... }), Polar({ ... })]);
const chosen = resolveProvider(set, refs);
```

## resolveProvider

> **Kind:** Primitive

The provider that serves an account, with the context its world built.

A binding resolves once per call and then provides `context` — never
`provider.payments` — so a deployment with several providers builds each one
at startup instead of rebuilding a layer on every money operation.

### Providing the provider that serves one account

```ts
const chosen = resolveProvider(yield* PaymentsRouter, standing.refs);

if (chosen === null) return yield* new ProviderCapabilityMissing({ provider: "none", op: "createInvoice" });

yield* Effect.provide(invoice(chosen.provider), chosen.context);
```
