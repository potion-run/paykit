---
title: "Customers"
description: "A customer's record: the identity it recorded, the plans it holds and the controls it states over them."
---

> **Source:** [`packages/paykit/src/Billing/Customers.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Customers.binding.ts#L63)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.Customers`

A customer's record: the identity it recorded, the plans it holds and the
controls it states over them. `get` reads the billing view the deployment
already folded; `create` and `update` write a command and answer the customer
the write waited for, so the answer is the state a caller's next read sees.

`create` states the identity once and `getOrCreate` is the idempotent
sign-up path: a read first, and the same create only when the record is
absent (ADR 0045). Auto top-up, spend limits and usage alerts live here
rather than in the catalog: a support agent can change them without a deploy,
and the event log records what was in force when each spend happened
(ADR 0038).

## Reading a customer's controls

```typescript
const customers = yield* Paykit.Customers(account);
const customer = yield* customers.get();
const limit = customer.billingControls.spendLimits?.find((row) => row.featureId === "requests");
```

## Recording a customer, then a retry that records nothing

```typescript
const customers = yield* Paykit.Customers(account);
const customer = yield* customers.getOrCreate({ name: "Ada", email: "ada@example.com" });
const again = yield* customers.getOrCreate({ name: "Ada", email: "ada@example.com" });
// customer.createdAt === again.createdAt; one CustomerCreated in the log
```
