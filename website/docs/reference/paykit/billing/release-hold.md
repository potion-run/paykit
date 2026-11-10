---
title: "ReleaseHold"
description: "Return a hold without billing it: the work failed, was cancelled, or never ran."
---

> **Source:** [`packages/paykit/src/Billing/ReleaseHold.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/ReleaseHold.binding.ts#L46)
> **Kind:** Binding · **Product:** Usage · **Provides:** `Paykit.ReleaseHold`

Return a hold without billing it: the work failed, was cancelled, or never
ran. Releasing after `expiresAt` still returns the units, because a late
release is a cleanup and not a charge.

## Returning capacity

```typescript
const releaseHold = yield* Paykit.ReleaseHold(account);
yield* releaseHold({ holdId, dedupeKey: `${turnId}:release` });
```
