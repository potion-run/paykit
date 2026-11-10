---
title: "TierCommand"
description: "Exports `TierGrantInput`, `withGrants`, `subscribeInputOf`, `scheduleTierChangeInputOf`, `purchaseCreditsInputOf`, `planChangeTier`."
---

> **Source:** [`packages/paykit/src/TierCommand.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/TierCommand.ts#L12)

## TierGrantInput

> **Kind:** Primitive

One join from a tier id to the input a command carries.

A command cannot read the catalog — `decide` is pure, so the terms a tier was
sold at travel on the command and into the event. Every path that sells,
schedules, previews or buys a tier therefore has to copy the same fields, and
a caller that copies them by hand can leave one out; `CatalogGuard` is the
backstop that refuses the result. These builders are the one place the copy
happens: each returns the plain input, or `null` when the catalog does not
sell the tier, and the caller wraps it in the command class it belongs to.

The tier's `kind` matters here: a one-off tier is a pack of credits, so it can
be bought but not subscribed to or moved onto. `planChangeTier` refuses
it; `purchaseCreditsInputOf` is the only builder that accepts one.

## withGrants

> **Kind:** Primitive

A plan's catalog terms with the plan items a caller states for a custom plan.

The array is folded into the record a command carries, and the result is
judged by the same pure guard a wire caller meets — so an in-process sender
and an HTTP caller cannot disagree about what a plan may grant. Omitting
`grants` keeps the catalog's defaults, which is the ordinary case; stating
them for a fixed plan is refused by the guard's exact-match rule, not by a
second check here (ADR 0041 §6).

A `price` is the negotiated price a custom plan was sold at (ADR 0042 §3).
It replaces the catalog's price on the command, and the guard accepts it only
for a plan the catalog opted into bespoke terms; on any other plan the price
must match the catalog exactly.

### Attaching a bespoke deal

```typescript
const plan = planChangeTier(catalog, "enterprise", state, now);
if (plan !== null) {
  const granted = withGrants(catalog, plan.input, request.grants, request.price);
  if (granted.mismatch !== null) return yield* granted.mismatch;
  yield* subscription.send(ref, new ChangeTier(granted.input), { commandId });
}
```

## subscribeInputOf

> **Kind:** Primitive

The input a `Subscribe` carries for a tier, or `null` when the catalog does
not sell it. A one-off pack is also refused: a pack is bought through
`PurchaseCredits`, never activated as a standing.

### Building a subscribe from the catalog

```typescript
const input = subscribeInputOf(catalog, "pro", { anchorTz: "UTC" });
if (input !== null) yield* new Subscribe(input);
```

## scheduleTierChangeInputOf

> **Kind:** Primitive

The input a `ScheduleTierChange` carries for a tier, or `null` when the
catalog does not sell it. A one-off pack is refused: scheduling a pack would
move the standing onto a bundle with no allowances at the boundary.

### Scheduling a move from the catalog

```typescript
const input = scheduleTierChangeInputOf(catalog, "pro", currencyOf(standing));
if (input !== null) yield* new ScheduleTierChange(input);
```

## purchaseCreditsInputOf

> **Kind:** Primitive

The input a `PurchaseCredits` carries for a one-off pack, or `null` when the
catalog lacks it or the tier is not a pack. `invoiceId` is the invoice an
auto top-up opened; a webhook purchase omits it.

### Buying a pack from the catalog

```typescript
const input = purchaseCreditsInputOf(catalog, "pack");
if (input !== null) yield* new PurchaseCredits(input);
```

## planChangeTier

> **Kind:** Primitive

The `ChangeTier` a move implies, and the proration the same prices and period
would charge, or `null` when the catalog does not sell the tier or it is a
one-off pack.

`Preview` and the admin apply path both call this, so a catalog field cannot
be added to one and forgotten in the other. The function is pure: `at` is the
same clock value the caller passes to `Subscription.predict` or to the
command that will decide it.

### Quoting a move before it is sent

```typescript
const plan = planChangeTier(catalog, "scale", state, now);
if (plan !== null) {
  yield* subscription.send(ref, new ChangeTier(plan.input), { commandId });
  return { due: plan.proration?.due ?? 0 };
}
```
