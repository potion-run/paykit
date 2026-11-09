# 0037 — A lifetime grant is a balance source, not a plan allowance

- **Status:** Accepted
- **Date:** 2026-11-10
- **Follows:** [0002](./0002-credits-are-the-unit-of-account.md), [0012](./0012-a-tier-change-can-be-scheduled-for-the-boundary.md), [0035](./0035-plans-plan-items-and-balance-sources.md)

## Context

`creditsExpire` has two values: `"period"` and `"never"`. The close treats a scheduled plan change
as a replacement of the whole pool: `pendingTier.credits + prepaidCredits`, with no expiry event
for the old plan's credits. A `"never"` plan therefore loses its balance at a scheduled change,
while the same `"never"` on a one-off pack survives because it is carried in `prepaidCredits`.

The reason is that two different facts share one field:

- the plan's own allowance, which belongs to the plan period and is replaced when the plan changes;
- a lifetime grant, which belongs to the customer and outlives any plan.

A plan change is not a reason to destroy a lifetime grant, and it is a reason to replace the
plan's allowance. One field cannot express both.

## Decision

**1. A lifetime grant is a source.** `BalanceSource.kind: "one_off"` (or `"grant"`) carries a
grant that never resets and never expires. It is created by a one-off purchase or a standalone
grant and it is independent of any plan. It survives a plan close, a scheduled plan change, a
cancellation and a new activation.

**2. A plan allowance is a source with the plan's lifetime.** A subscription plan item creates a
source of `kind: "plan"` (or `"addon"`). It is replaced at the boundary by the new plan's source.
The old plan source is expired and the expiry is recorded; it is never silently dropped.

**3. `creditsExpire: "never"` is not a consumable plan-item setting.** A consumable subscription
plan item is a period allowance. A lifetime credit grant is expressed as a one-off item, an add-on
item or a standalone balance grant. The catalog refuses `resets: "never"` on a consumable
subscription plan item. A non-consumable seat is the exception: it never resets because it is a
seat, not a lifetime credit. Existing `creditsExpire: "never"` state decodes into a `one_off`
source; the old field is not carried forward as a plan setting.

**4. Deduction spends expiring sources first.** Plan and add-on sources are consumed before
rollover sources, and rollover before lifetime sources. Within a kind, the soonest expiry is
spent first. A lifetime source is the last money a customer can spend, which is what "never
expires" should mean.

**5. A rollover is its own source.** At a reset, the unused part of a plan or add-on source
becomes a `rollover` source with the plan item's `max` and expiry. It is not added back to the
plan's `granted` count. A rollover expires on its own schedule even when the plan does not.

## Consequences

- A scheduled change no longer needs a special `creditsExpire` rule. It replaces plan sources and
  leaves lifetime and rollover sources alone.
- A plan's unused allowance is not carried through a scheduled change. A lifetime grant is.
- `credits` and `prepaidCredits` become derived compatibility fields during the migration; the
  balance view is the truth.
- The close records `CreditsExpired` for every plan source it replaces, so the pool's fold is
  complete.
- The API exposes lifetime grants as `balances.create({ reset: { interval: "one_off" } })` or a
  one-off plan item, not as a plan field.

## What this does not decide

- Whether unused plan allowance may be carried on an immediate upgrade. That is a separate
  `carryOverBalances` decision and it creates a rollover-like source, not a lifetime grant.
- Expiry of promotional grants. A standalone grant may carry `expiresAt`; that is still a source,
  not a plan.
