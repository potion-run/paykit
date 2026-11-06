# 0020 — A terminal standing is replaced, not moved

- **Status:** Accepted
- **Date:** 2026-11-06
- **Follows:** [0012](./0012-a-tier-change-can-be-scheduled-for-the-boundary.md), [0019](./0019-a-refund-names-the-charge-it-reverses.md)

## Context

The reachable phase table made a gap visible. `isTerminalStatus` existed, but only the period
machine read it: `ClosePeriod` refused a terminal standing and `PeriodRollover` stopped arming the
next deadline. Everything else was a per-command check, and several commands did not make it.
`ChangeTier` changed the tier of an expired account, `ScheduleTierChange` scheduled a boundary that
could never arrive, and `ConsumeCredits` spent the pool of a standing that had ended. The result was
a state no read could explain: a terminal standing with a new tier, a pending change, or a smaller
balance.

`Subscribe` had the mirror problem. It guarded the catalog and the currency, not the standing, so a
second activation on an active account reset the period, the counters and the holds. The webhook
edge already refused that reset; the command did not.

## Decision

**1. The guard is one rejection, not a status check per command.** A command that needs an open
period refuses a terminal standing with `StandingEnded`, carrying the account and the status. The
commands are `ChangeTier`, `ScheduleTierChange` and `ConsumeCredits`. The rejection is declared on
each command, in each binding's refusal union and in the admin `ChangeTierRejection`, so a transport
caller sees the same typed answer as an in-process caller.

**2. Some commands stay outside the guard.** `GrantCredits` is goodwill and does not need a period;
`PurchaseCredits` buys a pack that survives one; `Refund` and `AttachProviderRef` are operator acts
over money and vendor ids. A terminal standing can receive those, and the period machine still
refuses to open another period. `Resume` is left alone: it clears the cancellation flag a close
carried into `canceled`, and changing that is a separate decision.

**3. A new activation replaces a terminal standing; it does not move an open one.** `Subscribe`
refuses a non-terminal standing with `AlreadySubscribed`. `Expired` and `Canceled` remain the
reactivation path the webhook uses for `payment_succeeded`, and `StartTrial` remains the one
deliberate replacement for an open standing, because a free tier converting to a trial is a product
flow the stories already pin.

**4. The edge table records the refusal as a self-edge.** `Expired + trial` still reaches
`Trialing` and `Expired + activate` still reaches `Active`; the commands that would move a terminal
standing's money now land on the same tag. A later change to a guard is one cell in
`STANDING_PHASE_TRANSITIONS`, and the table test says so.

## Consequences

- A terminal standing can no longer reach a smaller allowance, a scheduled change that never
  applies, or a spent pool. `ChangeTier` and `ScheduleTierChange` answer `StandingEnded` rather than
  recording an event the close will never read.
- A second `Subscribe` on an open standing answers `AlreadySubscribed` and leaves the first standing
  untouched. The `Subscribe` operation checks the same rule before it opens a checkout, so a second
  paid plan cannot take money the command will refuse; the webhook converts a race to `ignored`
  rather than failing a provider delivery.
- A deployment that relied on `ConsumeCredits` after expiry must reactivate first, which is the
  same rule `TrackUsage` already follows.
- No state field, event or migration changes. The guard is in `decide`; the table and its test are
  the specification.
