# 0012 — A tier change can be scheduled for the boundary

> **Amended by [0037](./0037-a-lifetime-grant-is-a-balance-source.md).** A scheduled change replaces
> the old plan's balance source and grants the new plan's source. Lifetime sources survive; a
> plan's unused allowance does not.

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0009](./0009-only-a-blocking-allowance-refuses-a-move-below-its-usage.md), [0011](./0011-a-tier-change-cannot-move-into-a-ceiling-already-passed.md)

## Context

Two decisions refuse a mid-period move: an allowance that blocks cannot go below what is used
([0009](./0009-only-a-blocking-allowance-refuses-a-move-below-its-usage.md)), and no tier can be entered
whose money or unit ceiling the period has already passed
([0011](./0011-a-tier-change-cannot-move-into-a-ceiling-already-passed.md)). Both are right — the
alternative is a standing no command can leave — and both leave the same request unserved: *I want the
cheaper plan.*

`ScheduleCancellation` already answers the neighbouring request with `cancelAtPeriodEnd`: the standing
ends at the close. What it cannot express is "end up on that other tier instead".

## Decision

**1. A scheduled change is data on the standing, carried by the event.** `ScheduleTierChange` records
`{ tier, allowances, price?, credits, creditsExpire, rates, currency?, interval? }` as `pendingTier`.
The terms travel with it because the close runs without a catalog: the boundary has to be able to apply
the change from the log alone, exactly as `SubscriptionActivated` and `TierChanged` already do.

**2. The close applies the change before it resets the counters.** `closePeriodEvents` emits
`TierChanged` first, then `PeriodClosed`, `UsageReset` and `CreditsExpired`:

```ts
const allowances = pending?.allowances ?? state.allowances;
const resets = Object.entries(allowances).map(([feature, allowance]) => resetOf(state, feature, allowance));
```

Order is the whole point. `UsageReset` reads the allowances in state, so a reset emitted ahead of the
change would start the next period on the tier being left. The reset is computed from the *new* tier's
allowances, which is also what makes the boundary the right place for this: the counters a mid-period
move would have had to inherit are reset in the same transaction, so the smaller allowance starts on a
clean period rather than on one it cannot cover.

**3. Scheduling is replaceable, and a move cancels it.** A second `ScheduleTierChange` overwrites the
first — last intent wins, and no history of abandoned schedules is kept beyond the events. A mid-period
`ChangeTier` clears `pendingTier`, because the account has already moved and applying the old intent at
the boundary would silently undo the change the account paid for.

**4. The money is the boundary's.** A scheduled change carries no proration: the period it was scheduled
in has ended, so there is nothing to prorate. The `priceAfter` on the `TierChanged` is what the next
period bills.

## What this does not decide

- **Withdrawing a schedule.** There is no `WithdrawTierChange` yet; a caller can replace it with the
  current tier, but that is a workaround rather than an answer. It belongs beside `Resume`, which is what
  withdraws a cancellation.
- **The admin and preview surfaces.** `ChangeTierRejection` and `PreviewRejection` do not mention the
  schedule commands. The model is the slice here; the surfaces follow when the console needs a "change
  at period end" button.
- **Applying it when the tier left the catalog.** The terms are frozen on the event at scheduling time,
  so a catalog edit afterwards does not change what was promised. That is the same rule as prices on
  `UsageRecorded`, and it is why the event carries them rather than an id.
