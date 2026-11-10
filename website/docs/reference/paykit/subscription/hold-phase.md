---
title: "HoldPhase"
description: "Exports `HOLD_STATUS_TRANSITIONS`, `nextHoldStatus`."
---

> **Source:** [`packages/paykit/src/Subscription/HoldPhase.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/HoldPhase.ts#L8)

## HOLD_STATUS_TRANSITIONS

> **Kind:** Primitive

Where a hold goes from every status under every move. The closed statuses
are absorbing: a release after a settle, or a settle after a sweep, stays
where it is. The shape is the same total table as the standing's:
`[status][move]`, never `undefined`.

## nextHoldStatus

> **Kind:** Primitive

The status one move leaves behind. Total in both arguments, so a caller
never has to handle `undefined` for a command that found a closed hold.

### Asking the hold table

```typescript
nextHoldStatus("open", "expire"); // "expired"
nextHoldStatus("open", "settle"); // "settled"
```
