---
title: "StartTrial"
description: "Open a trial on a tier."
---

> **Source:** [`packages/paykit/src/Billing/StartTrial.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/StartTrial.binding.ts#L65)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.StartTrial`

Open a trial on a tier. The trial opens on the cadence its price states, so an
annual trial converts into an annual period, and its deadline is the first
period's end — which is why a deadline behind the start is refused rather than
opening a period the next tick closes.

A trial can be taken once per account: `TrialAlreadyUsed` is the second
attempt, not a bug. `ExtendTrial` is the admin command that moves a deadline
forward.

## Starting a fourteen-day trial

```typescript
const startTrial = yield* Paykit.StartTrial(account);
yield* startTrial({
  tier: "pro",
  trialEndsAt: DateTime.add(now, { days: 14 }),
  dedupeKey: requestId,
});
```
