---
title: "Webhooks"
description: "Exports `WEBHOOK_TRANSITIONS`, `webhookActionOf`."
---

> **Source:** [`packages/paykit/src/Webhooks.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Webhooks.ts#L125)

## WEBHOOK_TRANSITIONS

> **Kind:** Primitive

What one provider event does to one standing phase. A total table, so the
edge's `if` chain is a lookup: an event that records nothing is `ignored`,
not a missing branch. The rows are the provider's four kinds; the columns
are the same phases `STANDING_PHASE_TRANSITIONS` uses.

A one-off pack is handled before the table: it buys credits whether or not a
standing exists, so it is `purchased` in every phase and never an activation.

## webhookActionOf

> **Kind:** Primitive

The action one delivery names, from the event's kind and the standing it
found. A caller that has already handled `oneOff` can use this to skip the
branch chain; the operation uses it for exactly that.

### Classifying a delivery

```typescript
webhookActionOf("payment_failed", expiredState); // "ignored"
```
