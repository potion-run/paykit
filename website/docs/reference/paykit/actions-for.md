---
title: "actionsFor"
description: "The actions that make sense for a standing, in a stable display order."
---

> **Source:** [`packages/paykit/src/AdminActions.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/AdminActions.ts#L181)
> **Kind:** Primitive

The actions that make sense for a standing, in a stable display order.

`ChangeTier` is offered only when the catalog has a tier the account is not
on, the currency matches, and (when entitlements are supplied) the account's
used and reserved units fit the new tier's blocking allowances, unit ceiling
and money ceiling — the rules `ChangeTier`'s `DowngradeBelowUsage`,
`DowngradeBelowCeiling` and `DowngradeBelowSpend` apply. `ScheduleTierChange`
is offered for every other compatible tier, because a move those rules refuse
now is exactly what belongs at the boundary. `WithdrawTierChange` is offered
only while a change is scheduled. `Refund` is offered whenever a currency
still has money to send back, even on a terminal standing: it is a money
operation, not a move on the standing. The model still decides: this function
never replaces a rejection or a preview.

## Offering actions from a billing snapshot

```typescript
const actions = actionsFor(
  { status: "grace", tier: "pro", currency: "usd", cancelAtPeriodEnd: false },
  { catalog, entitlements },
);
// GrantCredits, ChangeTier, RecordPayment, RecordPaymentFailure, Recover, Expire
```
