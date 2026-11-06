# 0021 — Hold expiry is a state, and a close releases what it clears

- **Status:** Accepted
- **Date:** 2026-11-06
- **Follows:** [0004](./0004-a-hold-is-one-call-and-an-id.md)

## Context

A hold was `open`, `settled` or `released`. The deadline that ends an abandoned hold emitted the
same `UsageReleased` event as a caller's release, so the log could not say whether work was
cancelled or simply ran out of time. A period close was worse: `UsageReset` dropped every open hold
for a feature that reset, and the entities disappeared without a release event. The timeline showed
the units as held forever, and a caller settling after a release got `HoldSettled`, a rejection that
made a cleanup look like a double charge.

ADR [0004](./0004-a-hold-is-one-call-and-an-id.md) already says a hold is an entity, one call
settles it, and a closed hold stays as an audit record. The missing half was the reason a hold
closed.

## Decision

**1. `expired` is a fourth hold status.** `HoldStatus` is `open | settled | released | expired`.
`HoldElapsed` records `expired`; `ReleaseHold` records `released`; a period close records
`released` with the reason `reset`.

**2. `UsageReleased` carries the reason.** The event gains an optional
`reason: "released" | "expired" | "reset"`. Absence means `released`, so every event written before
the field decodes unchanged and no migration is needed. The reason is evidence on the event; the
status is the fold of it.

**3. A close releases before it resets.** `closePeriodEvents` emits one `UsageReleased` per open
hold on a feature that does not keep its counters, before `PeriodClosed` and `UsageReset`, with a
running `remainingAfter` per feature. The reset then clears the entities as before, but the log now
says what left the allowance and how much. Holds on a `resets: "never"` feature still survive the
boundary.

**4. A settle after a close is a no-op, not a refusal.** Settling a `released` or `expired` hold
records nothing and answers `{ billed: 0, released: 0 }`. The work was never billed; a retry after
a caller's own release or a sweep is a replay. `HoldSettled` stays for releasing a `settled` hold,
where the units really were billed.

## Consequences

- The timeline and the hold panel can tell a cancelled hold from an expired one, and a period close
  has a per-hold entry instead of a silent drop.
- Old logs fold to `released` for every release event, which is the status they had before. No
  version bump and no event rewrite.
- A settle after a release no longer fails; a caller that needs to know whether the work was billed
  reads the reply or the hold's status.
- The hold table and its test are the specification: `open -> settled`, `open -> released`,
  `open -> expired`, and every closed status is terminal for a second close.
