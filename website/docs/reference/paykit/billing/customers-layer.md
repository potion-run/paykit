---
title: "Customers.layer"
description: "Exports `CustomersRead`, `CustomersLive`."
---

> **Source:** [`packages/paykit/src/Billing/Customers.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Customers.layer.ts#L13)

## CustomersRead

> **Kind:** Primitive

The read a `Customers` verb answers from: one account's billing view. It is a
service so the in-process layer and the Api layer compose the same binding
instead of writing the customer twice.

## CustomersLive

> **Kind:** Layer · **Product:** Subscription · **Provides:** `Paykit.Customers`

The customer surface: the record a billing page shows and the writes a caller
makes over it. It adds no state of its own: `get` reads the billing view, and
every write sends its command and reads the view it waited for, so a caller
cannot see a customer the model has not recorded.

`create` records the identity and `getOrCreate` is the idempotent sign-up
path — a read, and the same create only when the record is absent — so the
two verbs keep distinct meanings (ADR 0045).

### Changing a customer's ceiling

```typescript
const customers = yield* Paykit.Customers(account);
yield* customers.update({
  billingControls: {
    spendLimits: [{ featureId: "requests", amount: 10_000 }],
    usageAlerts: [{ featureId: "requests", at: 8_000 }],
  },
});
```
