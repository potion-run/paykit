---
title: "StandingPhase"
description: "Exports `standingPhaseOf`, `standingPhaseOfView`, `standingPhaseTagOfStatus`, `standingConditionsOf`, `STANDING_PHASE_TRANSITIONS`, `nextStandingPhase`, `standingTransitionOf`, `STANDING_PHASE_EDGES`."
---

> **Source:** [`packages/paykit/src/Subscription/StandingPhase.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Subscription/StandingPhase.ts#L98)

## standingPhaseOf

> **Kind:** Primitive

The phase a standing is in at `at`.

`status` alone is not the phase. A trial whose deadline has passed is still
`Trialing` until `PeriodEnded` records the close; an active standing past
its period end is still `Active`; a grace window whose deadline passed is
still `Grace`. `overdue` is the clock, and the tag is the log. Reading only
the status hides the window between the two.

Pure: the clock is a parameter, so a console, a test and a replay can ask
the same question of the same state.

### Reading a phase

```typescript
const phase = standingPhaseOf(state, at);
// { _tag: "Trialing", deadline: 2030-01-15T00:00:00Z, overdue: true }
```

## standingPhaseOfView

> **Kind:** Primitive

The phase of a standing a read model carries. The view has the status and
the boundary, so a console can say "the period ended and no close has
landed" without holding the aggregate state.

### Reading a phase from a billing row

```typescript
standingPhaseOfView(billing, readAt);
// { _tag: "Active", deadline: 2030-02-01T00:00:00Z, overdue: true }
```

## standingPhaseTagOfStatus

> **Kind:** Primitive

The phase tag a status alone names. A read model that has no clock can still
say which phase it is in; `overdue` needs `standingPhaseOfView`.

### Classifying a status

```typescript
standingPhaseTagOfStatus("grace"); // "Grace"
```

## standingConditionsOf

> **Kind:** Primitive

The orthogonal state a standing carries beside its phase.

The phase says where the lifecycle is; these say what the next command will
find when it gets there. A pending tier on an expired standing, a cooldown
whose deadline passed, a hold past its expiry and a proration credit with no
consumer are all visible here instead of being inferred from absent fields.

### Reading what the next command will see

```typescript
const conditions = standingConditionsOf(state, at);
// { pendingTier: "pro", topUpCooldown: "lapsed", lapsedHolds: 1, ... }
```

## STANDING_PHASE_TRANSITIONS

> **Kind:** Primitive

Every phase under every move. A total table, not a sparse edge list: a move
that cannot happen is a self-edge, so a reader can ask `[phase][move]`
instead of replaying a chain of guards. The shape is Alchemy's
`SQLITE_TRANSITIONS` table in `@alchemy.run/sql/SqlFile`: every state has
every token and the runner is a single index.

The surprising cells are the honest ones. `Active + trial -> Trialing` is
reachable because `StartTrial` guards on `trialUsed`, not on the standing
already being open; `Expired + activate -> Active` is how a payment
reactivates a terminal account. Anything a later guard refuses becomes a
self-edge here, which is the same edit as changing the guard.

## nextStandingPhase

> **Kind:** Primitive

The phase tag one move leaves behind. Total in both arguments: an impossible
move answers the same tag, so a caller never has to handle `undefined` just
because the standing refused the command.

### Asking the table

```typescript
nextStandingPhase("Grace", "expire"); // "Expired"
nextStandingPhase("Active", "expire"); // "Active"
```

## standingTransitionOf

> **Kind:** Primitive

The move a command names, as the table's second key.

A close is the one command whose move depends on the standing: with a
cancellation scheduled it is `cancelAtBoundary`, otherwise `close`. Every
other command is classified by its tag alone; a command that only touches
counters, credits or refs is `other`, which is a self-edge in every phase.

A command that records nothing — an early `PeriodEnded`, a repeat `Expire`
— is not a move. The table classifies what a decision did, so a caller
holding an empty decision stays on the same phase without consulting it.

### Classifying a close

```typescript
standingTransitionOf({ _tag: "PeriodEnded" }, { ...state, cancelAtPeriodEnd: true });
// "cancelAtBoundary"
```

## STANDING_PHASE_EDGES

> **Kind:** Primitive

The annotated view of `STANDING_PHASE_TRANSITIONS`: one row per pair of
phases the table can reach (including each phase's self-edge), with the
commands that take it and the notes a reader needs. The table is the source of truth; this list is how a
human reads it, and `test/standing/Phase.test.ts` holds the two together.
