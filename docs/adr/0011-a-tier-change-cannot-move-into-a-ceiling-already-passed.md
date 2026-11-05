# 0011 — A tier change cannot move into a ceiling the period already passed

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0005](./0005-a-spend-cap-is-a-ceiling-in-units.md), [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md), [0009](./0009-only-a-blocking-allowance-refuses-a-move-below-its-usage.md)

## Context

A standing carries two ceilings per billed feature, and both are kept across a tier change:

- a **money ceiling**, `moneyCap`, enforced by `TrackUsage`, `Hold` and `SettleHold` as
  `billed + charge > moneyCap`;
- a **unit ceiling**, `included + cap`, enforced as `used + reserved + amount > included + cap`.

Both are records of what this period may still spend, and `billed` and `used` survive a
`TierChanged` because a tier change is not a period boundary — `UsageReset` is what clears them.

`ChangeTier` did not check either. Before [ADR 0009](./0009-only-a-blocking-allowance-refuses-a-move-below-its-usage.md)
that was invisible: the old refusal to move below usage incidentally blocked the money case. 0009 narrowed
that rule to blocking allowances, correctly, and left money and units unchecked.

The result is a standing no command can leave. An account that billed 80 against a generous cap moves to
a tier whose cap is 50; the change succeeds, `billed` stays 80, and every later `TrackUsage` for that
feature answers `MoneyCapExceeded` — even for one unit — until the period closes. `check()` reports
`allowed: false` with `standing: "good"`, which is the right reading of "out of what you bought" arriving
at the wrong moment: the instant the account changed plan.

## Decision

**1. A change is refused when it would put the period past a ceiling it has already reached.**

```ts
const billed = billedOf(current, feature);
if (allowance.moneyCap !== undefined && billed > allowance.moneyCap) {
  return new DowngradeBelowSpend({ feature, moneyCap: allowance.moneyCap, billed });
}
const ceiling = spendCeilingOf(allowance);
if (ceiling !== null && used + reserved > ceiling) {
  return new DowngradeBelowCeiling({ feature, ceiling, used, ...(reserved === 0 ? {} : { reserved }) });
}
```

Both sit beside `DowngradeBelowUsage`, which keeps answering its own question — a *blocking* allowance
that cannot cover what is already owed.

**2. Two tags, because the evidence is two sentences.** A console showing "$80 billed against a $50
cap" and one showing "200 units used against a 150-unit ceiling" are different explanations, and a
caller that wants to tell them apart should not have to inspect a unit field. Both carry the feature and
the new ceiling; `DowngradeBelowCeiling` also carries `reserved`, because open holds are owed.

**3. It is the same argument as 0009, in money.** Moving into a ceiling you have passed is asking for a
plan that cannot be served for the rest of the period. The state it produces is one every other command
refuses, and dead states are what an event-sourced model exists to avoid: a replay would reproduce an
account that can do nothing.

**4. The product answer for "pay less now" is a scheduled change, not a forced one.** `ScheduleCancellation`
already models `cancelAtPeriodEnd`; a downgrade belongs at the boundary, where the ceilings reset
legitimately. This decision refuses the mid-period move so that the boundary is the only place a smaller
allowance can start — and the counters reset with it.

## What this does not decide

- **A scheduled downgrade.** `tierAtPeriodEnd`, applied by `PeriodRollover` beside `cancelAtPeriodEnd`.
  It is the natural companion to this refusal and a separate slice.
- **Profiles that were already inconsistent.** A log written before this rule can hold a standing past a
  ceiling. It is left as it is; the next `ChangeTier` refuses to add another.
- **Whether the counters should reset on a change.** A fresh ceiling at a change would double what one
  period may spend and needs a baseline in the log. Rejected as more machinery than the case is worth.
