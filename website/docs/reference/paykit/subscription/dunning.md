---
title: "dunning"
description: "Turn on a dunning retry ladder."
---

> **Source:** [`packages/paykit/src/Subscription/Dunning.policy.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/Dunning.policy.ts#L45)
> **Kind:** Layer

Turn on a dunning retry ladder. Without this layer the policy still owns
grace and expiry, but it never charges a saved method; the vendor's own
retries are the only attempts, exactly as before.

Each entry is measured from the first failure of the run, not from the
preceding attempt, so a late policy run does not move the rest of the ladder.
A retry at or after the standing's `graceUntil` is not scheduled: the grace
deadline remains the hard stop. The retry is made against the account's saved
method through `Payments.charge` and is keyed by the run and the attempt, so
a redelivered policy run is the charge it already took. A deployment that
turns this on should turn the vendor's own dunning off, or both schedules
will attempt the same collection.

## Retrying a declined card three times

```typescript
const layer = Paykit.ModelHandlers.pipe(
  Layer.provideMerge(Paykit.paymentsRouter(provider)),
  Layer.provideMerge(
    Paykit.dunning({
      retries: [Duration.days(1), Duration.days(3), Duration.days(7)],
    }).pipe(Layer.orDie),
  ),
);
```
