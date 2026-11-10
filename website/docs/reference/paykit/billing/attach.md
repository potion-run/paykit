---
title: "Attach"
description: "Exports `Attach`, `Update`, `PreviewAttach`, `PreviewUpdate`."
---

> **Source:** [`packages/paykit/src/Billing/Attach.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Attach.binding.ts#L820)

## Attach

> **Kind:** Binding · **Product:** Plans · **Provides:** `Paykit.Attach`

Buy a plan, move to a bigger one now, or schedule a smaller one for the
boundary. This is the operation a caller should use instead of choosing
between `Subscribe`, `ChangeTier` and `ScheduleTierChange`.

An upgrade is immediate; a downgrade waits for the boundary by default. A
positive proration is collected in the same operation unless the caller asks
for no proration. Quantities for a scheduled change or a checkout are refused
for now, because the current commands cannot carry them.

### Buying or moving a plan

```typescript
const attach = yield* Paykit.Attach(account);
yield* attach({ planId: "free", idempotencyKey: "attach-1" });
yield* attach({ planId: "pro", idempotencyKey: "attach-2" });
```

## Update

> **Kind:** Binding · **Product:** Plans · **Provides:** `Paykit.Update`

Change quantities, cancel at the boundary, or take a future intent back. A
cancellation drops a pending plan change; an uncancel clears whichever intent
is pending. An immediate cancellation is refused until its command lands.

### Updating a running plan

```typescript
const update = yield* Paykit.Update(account);
yield* update({ idempotencyKey: "seats-1",
                featureQuantities: [{ featureId: "seats", quantity: 8 }] });
yield* update({ idempotencyKey: "cancel-1", cancelAction: "cancel_end_of_cycle" });
```

## PreviewAttach

> **Kind:** Binding · **Product:** Plans · **Provides:** `Paykit.PreviewAttach`

The plan move `attach` would make, decided without recording anything.

### Showing a plan change first

```typescript
const preview = yield* Paykit.PreviewAttach(account);
const answer = yield* preview({ planId: "pro" });
```

## PreviewUpdate

> **Kind:** Binding · **Product:** Plans · **Provides:** `Paykit.PreviewUpdate`

The commands `update` would send, decided without recording anything.

### Showing a cancellation first

```typescript
const preview = yield* Paykit.PreviewUpdate(account);
yield* preview({ cancelAction: "cancel_end_of_cycle" });
```
