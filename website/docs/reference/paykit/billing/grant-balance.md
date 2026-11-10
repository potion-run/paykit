---
title: "GrantBalance"
description: "Create a standalone grant of a counted feature: the API behind Paykit.Balances(account).create."
---

> **Source:** [`packages/paykit/src/Billing/GrantBalance.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/GrantBalance.binding.ts#L70)
> **Kind:** Binding · **Product:** Usage · **Provides:** `Paykit.GrantBalance`

Create a standalone grant of a counted feature: the API behind
`Paykit.Balances(account).create`. A grant belongs to the customer, not to a
plan — the plan and rollover sources are spent first, and a lifetime grant
survives every close and plan change (ADR 0037).

## Granting 50 research runs

```typescript
const grant = yield* Paykit.GrantBalance(account);
yield* grant({
  featureId: "research_runs",
  granted: 50,
  expiresAt: DateTime.add(DateTime.unsafeNow(), { months: 1 }),
});
```
