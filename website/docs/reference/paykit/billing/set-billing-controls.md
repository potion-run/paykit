---
title: "SetBillingControls"
description: "Replace a customer's billing controls: its auto top-up line, its spend ceilings and its usage alerts (ADR 0038)."
---

> **Source:** [`packages/paykit/src/Billing/SetBillingControls.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/SetBillingControls.binding.ts#L88)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.SetBillingControls`

Replace a customer's billing controls: its auto top-up line, its spend
ceilings and its usage alerts (ADR 0038). It works before a plan exists, so a
customer can state a refill line or a limit before it buys anything; an equal
object records nothing.

The binding builds the catalog facts the command carries from the deployment's
own catalog, so the caller states controls and never catalog data.

## Lowering a ceiling

```typescript
const controls = yield* Paykit.SetBillingControls(account);
yield* controls({
  billingControls: { spendLimits: [{ featureId: "requests", amount: 5_000 }] },
});
```
