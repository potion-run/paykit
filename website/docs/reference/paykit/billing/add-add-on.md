---
title: "AddAddOn"
description: "Attach an add-on plan beside whatever the account already runs."
---

> **Source:** [`packages/paykit/src/Billing/AddAddOn.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/AddAddOn.binding.ts#L86)
> **Kind:** Binding · **Product:** Plans · **Provides:** `Paykit.AddAddOn`

Attach an add-on plan beside whatever the account already runs. It is a named
verb because the attach path's add-on branch is a branch: a caller that means
"add an add-on" says so, and a plan that is not one is refused rather than
quietly replacing a group's plan.

## Stacking an add-on

```typescript
const addAddOn = yield* Paykit.AddAddOn(account);
yield* addAddOn({ planId: "support", idempotencyKey: "add-support" });
```
