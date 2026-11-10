---
title: "Paykit"
description: "The four export groups as one namespace, so the docs' Paykit.feature(...) and the flat named exports are the same functions."
---

> **Source:** [`packages/paykit/src/Paykit.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Paykit.ts#L55)
> **Kind:** Primitive

The four export groups as one namespace, so the docs' `Paykit.feature(...)`
and the flat named exports are the same functions. Nothing here is a second
implementation; it is a reading order.

Every runtime verb is a binding named for its command: `Paykit.TrackUsage(account)`
returns the verb, and the verb takes the rest.

## Declaring and selling

```typescript
const messages = Paykit.feature({ id: "messages", name: "Messages" });
const free = Paykit.plan({
  id: "free",
  grants: [Paykit.planItem(messages, { included: 100 })],
});
const pro = Paykit.plan({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.planItem(messages, { included: 2_000, overage: "bill" })],
});

const billing = yield* Paykit.BillingStack("Billing", {
  store: Paykit.MemoryStore(),
  providers: [Paykit.Manual()],
  catalog: { features: [messages], tiers: [free, pro] },
});

const subscribe = yield* Paykit.Subscribe(account);
yield* subscribe({ tier: "pro" });
```
