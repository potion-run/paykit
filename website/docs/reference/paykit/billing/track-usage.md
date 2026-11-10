---
title: "TrackUsage"
description: "Record usage in the same transaction that checks the allowance."
---

> **Source:** [`packages/paykit/src/Billing/TrackUsage.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/TrackUsage.binding.ts#L121)
> **Kind:** Binding · **Product:** Usage · **Provides:** `Paykit.TrackUsage`

Record usage in the same transaction that checks the allowance. A blocking
allowance refuses before anything is written; an `idempotencyKey` makes a
retry a replay. This is the metered charge: it prices from the catalog and
writes the money on the event, and it never calls a provider — the period
close is what tells the vendor.

The account is the bind and the request is the rest, so a second account is
not representable:

## Recording usage

```typescript
const trackUsage = yield* Paykit.TrackUsage(account);

yield* trackUsage({ featureId: "messages", value: 1, idempotencyKey: requestId });
```

## Holding capacity instead

Work that has started but not finished belongs in `Paykit.Hold`, which takes
the units now and bills only what ran.
