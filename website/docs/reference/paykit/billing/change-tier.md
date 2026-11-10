---
title: "ChangeTier"
description: "Change the tier a standing is on."
---

> **Source:** [`packages/paykit/src/Billing/ChangeTier.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/ChangeTier.binding.ts#L92)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.ChangeTier`

Change the tier a standing is on.

`Preview` shows the same proration before anyone agrees to it; `ChargeProration`
is what collects a positive one. A downgrade below what the period already
used or billed is refused, and so is a move that would land above a ceiling the
period has already passed.

## Moving to a bigger plan

```typescript
const changeTier = yield* Paykit.ChangeTier(account);
const { proration } = yield* changeTier({ tier: "scale", dedupeKey: requestId });
if (proration !== null && proration.due > 0) yield* chargeProration();
```
