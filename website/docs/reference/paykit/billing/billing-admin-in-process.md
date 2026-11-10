---
title: "BillingAdminInProcess"
description: "Every operator binding, implemented in the process that hosts the model."
---

> **Source:** [`packages/paykit/src/Billing/BillingAdminInProcess.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/BillingAdminInProcess.layer.ts#L52)
> **Kind:** Layer · **Product:** Console · **Provides:** `Paykit.GrantCredits`

Every operator binding, implemented in the process that hosts the model.

A **separate layer** from `BillingInProcess` on purpose: clearance is the
layer, so a deployment that provides this one has handed the operator commands
out, and a deployment that provides the tenant layer has not. The Api client
path is `BillingAdminApiLayer`; nothing at a call site changes.

Sends as the system actor, because the console that provides this layer has
already authenticated the operator — the deployment owns who may reach it.

## Providing the ops console

```typescript
const Ops = Layer.mergeAll(BillingAdminInProcess, catalogLayer(Catalog));

yield* (yield* Paykit.GrantCredits(account))({ amount: 250, dedupeKey: ticketId });
```
