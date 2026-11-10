---
title: "BillingStack"
description: "The deploy-time billing stack, in one call."
---

> **Source:** [`packages/paykit/src/BillingStack.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/BillingStack.ts#L84)
> **Kind:** Primitive · **Product:** Billing

The deploy-time billing stack, in one call.

It validates the catalog, refuses a provider price that disagrees with it,
refuses two providers that share a name, and refuses a priced tier nothing
can sell. Then it records the result in `Paykit.BillingStack` state — the
event log is application data, so the resource is retained on destroy.

The props take `MoneyProvider` values because that is what a deployment has.
The resource records `ProviderDescriptor`s because state is JSON: a
provider's `Layer` is runtime config, and the descriptor is what a later
deploy can diff. That mapping happens here, once, so `providerDescriptor`
never appears in user code.

The error channel is the same tagged union `validateStack` returns, so
`Effect.orDie` at the stack boundary is a choice rather than a workaround.

## Deploying a catalog

```typescript
const billing = yield* Paykit.BillingStack("Billing", {
  catalog: { features: [messages], tiers: [free, pro] },
  providers: [Paykit.Manual()],
  store: Paykit.MemoryStore(),
});

// billing.catalog — the validated catalog
// billing.tiers   — ["free", "pro"]
```
