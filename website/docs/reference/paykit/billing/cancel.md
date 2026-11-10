---
title: "Cancel"
description: "Exports `ScheduleCancellation`, `Resume`."
---

> **Source:** [`packages/paykit/src/Billing/Cancel.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Cancel.binding.ts#L122)

## ScheduleCancellation

> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.ScheduleCancellation`

End the standing at the period boundary. Nothing is billed for the time
after the close, and the account keeps what it bought until then — which is
why this is a schedule and not a destroy: money outlives the click.

### Scheduling a cancellation

```typescript
const cancel = yield* Paykit.ScheduleCancellation(account);
const { cancelAtPeriodEnd } = yield* cancel({ dedupeKey: `cancel:${requestId}` });
```

## Resume

> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.Resume`

Take a scheduled cancellation back. The standing keeps running to its next
boundary, so a resume before the close is the whole undo.

### Resuming

```typescript
const resume = yield* Paykit.Resume(account);
yield* resume({ dedupeKey: `resume:${requestId}` });
```
