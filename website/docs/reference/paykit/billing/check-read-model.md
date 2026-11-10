---
title: "CheckReadModel"
description: "Check over the edge read model: one row from billing_rm_, no event fold and no view to resolve."
---

> **Source:** [`packages/paykit/src/Billing/CheckReadModel.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/CheckReadModel.layer.ts#L10)
> **Kind:** Layer · **Product:** Usage · **Provides:** `Paykit.Check`

`Check` over the edge read model: one row from `billing_rm_*`, no event fold
and no view to resolve. This is the path a request at the edge takes when the
model lives somewhere else, and it answers exactly what `evaluateCheck` answers
— the same function, so the paths cannot disagree about a verdict.

Provide it beside `SqlBillingReadStore`. A deployment that hosts the model uses
`BillingInProcess` instead; a process that reads a replica uses this one; a
caller that crosses a service boundary uses `CheckOverTransport`.
