---
title: "CreateCustomer"
description: "Record the customer's identity: the name and email a billing page shows."
---

> **Source:** [`packages/paykit/src/Subscription/CreateCustomer.command.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/CreateCustomer.command.ts#L22)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.CreateCustomer`

Record the customer's identity: the name and email a billing page shows. A
customer exists as soon as this command records one, so a deployment can
create it before it buys anything, and no billing decision reads the fields
(ADR 0045).

The account is the customer, as everywhere else: this is a command on the
account's aggregate and the identity is customer state, not plan state. A
create with the details already in force records nothing, so a retry is a
replay; a create with different details is `CustomerExists`, because renaming
a customer is a separate concern and not in this slice.

## Recording a customer at sign-up

```typescript
const customers = yield* Paykit.Customers(account);
const customer = yield* customers.create({ name: "Ada", email: "ada@example.com" });
```
