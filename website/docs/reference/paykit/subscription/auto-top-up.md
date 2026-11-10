---
title: "autoTopUp"
description: "The auto top-up policy's configuration."
---

> **Source:** [`packages/paykit/src/Subscription/AutoTopUp.policy.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/AutoTopUp.policy.ts#L100)
> **Kind:** Layer

The auto top-up policy's configuration. The pack is catalog data by id; the
threshold is the tier's own field (`Tier.topUp`), so a free tier and an
enterprise tier refill on the lines their pools need. The cooldown is the
deployment's: it bounds how often one account can be charged, not what the
pack costs.

## Refilling a pool from a pack

at most once an hour
```typescript
const pro = Paykit.plan({
  id: "pro",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  credits: 50_000,
  topUp: { threshold: 5_000, cooldown: Duration.hours(1), pack: "credits_100k" },
  grants: [Paykit.planItem(messages, { included: 2_000 })],
});

const credits = Paykit.plan({
  id: "credits_100k",
  kind: "one_off",
  price: { amount: 4_900, currency: "usd", interval: "month" },
  credits: 100_000,
  grants: [],
});

const layer = Paykit.Model.layer(
  Paykit.ModelHandlers.pipe(
    Layer.provideMerge(Paykit.paymentsRouter(provider)),
    Layer.provideMerge(
      Paykit.autoTopUp({ catalog, pack: credits.id, cooldown: Duration.hours(1) }).pipe(
        Layer.orDie,
      ),
    ),
  ),
);
```
