# 0009 — Only a blocking allowance refuses a move below its usage

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0005](./0005-a-spend-cap-is-a-ceiling-in-units.md), [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md), [0008](./0008-a-report-names-the-price-each-unit-was-recorded-at.md)

## Context

`ChangeTier` refuses to move an account below what it has already used:

```ts
if (allowance.included !== "unlimited" && used + reserved > allowance.included) {
  return new DowngradeBelowUsage({ feature, included: allowance.included, used, reserved });
}
```

The refusal is about oversubscription — an allowance that cannot cover what is already owed — and for a
blocking allowance that is exactly right: past its count, `decide` refuses every request and the read
model reports a negative `remaining` for a feature that stops at zero.

The check does not ask what kind of allowance it is looking at. So it also refuses a *billed* allowance,
where `used > included` is the ordinary state and the overage is the whole point. The practical
consequence is that the unit price of a postpaid feature can only change while the period has billed
nothing, which makes the per-price report from
[ADR 0008](./0008-a-report-names-the-price-each-unit-was-recorded-at.md) unreachable in the case it
exists for. That ADR says so, and leaves this decision here.

## Decision

**The refusal is gated on the overage.** A change is refused below usage only when the new allowance
`overage` is `"block"`:

```ts
if (
  allowance.overage === "block" &&
  allowance.included !== "unlimited" &&
  used + reserved > allowance.included
) {
  return new DowngradeBelowUsage({ feature, included: allowance.included, used, reserved });
}
```

`"bill"` and `"allow"` both permit usage past `included`, so neither can be oversubscribed by a
change: the first bills the overage, the second gives it away. Moving between them, or moving a billed
feature to a lower `included`, is a normal commercial change and is now allowed.

**The tag does not move.** `DowngradeBelowUsage` keeps its name and its evidence (`feature`,
`included`, `used`, `reserved`) because a caller matches on the tag and the numbers are what a console
shows. Only what it means narrows, and its doc comment says so.

**A price change is what this unlocks.** With the gate narrowed, a mid-period `ChangeTier` to a tier
with a different `unitPrice` reaches the standing, `UsageRecorded` keeps recording the price each unit
was taken at, and the close reports the period in two lines. That is the behaviour the story
`splits one period's report across the prices its units were recorded at` tests.

## What it does not decide

- **A money ceiling already passed.** A billed allowance has a `moneyCap`, and a change to a tier with
  a lower one is not refused even when `billed` is already above it. That is a ceiling question — the
  same shape as ADR 0005's cap, which is a count and not a standing — and it is not settled here.
- **A proration for the repricing.** The proration `ChangeTier` carries is about the tier's own
  `price`, computed from `current.price` and `command.price`. A unit price is not part of it: usage
  already recorded keeps the price it was recorded at, which is the guarantee ADR 0006 §2 makes. If a
  commercial case appears for charging the difference on units already billed, that is a new event,
  not a wider proration.
- **A blocking allowance that the change makes blocking.** Moving a billed allowance to a blocking one
  is refused by this rule when usage is past the new `included`, which is correct but may surprise: the
  account is told `DowngradeBelowUsage` rather than "this tier blocks where the last one billed".
