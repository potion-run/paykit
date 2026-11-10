---
title: "ConsumeCredits"
description: "Spend credits from the account's pool: one pool per account, whatever feature the work belonged to."
---

> **Source:** [`packages/paykit/src/Billing/ConsumeCredits.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/ConsumeCredits.binding.ts#L51)
> **Kind:** Binding · **Product:** Credits · **Provides:** `Paykit.ConsumeCredits`

Spend credits from the account's pool: one pool per account, whatever feature
the work belonged to. A spend past the balance is refused in the same
transaction, and the answer is the reply the command computed.

This is the credits twin of [TrackUsage](/reference/paykit/billing/track-usage): a metered feature is counted
in its own units, a credit-priced one spends `amount × rate`, and an explicit
spend is what a caller uses when it priced the work itself.

## Spending credits for work that has no meter

```typescript
const consumeCredits = yield* Paykit.ConsumeCredits(account);
const { balance } = yield* consumeCredits({ amount: 40, dedupeKey: reportId });
```
