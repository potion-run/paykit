---
title: "CreateCustomer"
description: "Record the identity a billing page shows for this account: its name and its email address."
---

> **Source:** [`packages/paykit/src/Billing/CreateCustomer.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/CreateCustomer.binding.ts#L92)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.CreateCustomer`

Record the identity a billing page shows for this account: its name and its
email address. A customer exists as soon as this command records one, so a
deployment can create it before it buys anything; no billing decision reads
the fields, and a plan change or a close leaves them alone (ADR 0045).

A create is idempotent on equal details, whether the retry carries the same
command id or derives it again: the second write records nothing and answers
the customer the first one left. A create with different details is
`CustomerExists` and records nothing — renaming a customer is its own
command, and this slice does not invent one. `Paykit.Customers(account)
.getOrCreate` is the sign-up path: it answers an existing customer untouched.

## Recording a customer at sign-up

```typescript
const createCustomer = yield* Paykit.CreateCustomer(account);
const { customer } = yield* createCustomer({ name: "Ada", email: "ada@example.com" });
```
