# 0039 — One plan per group, add-ons stack, and a schedule is a list of phases

- **Status:** Accepted
- **Date:** 2026-11-11
- **Follows:** [0012](./0012-a-tier-change-can-be-scheduled-for-the-boundary.md), [0020](./0020-a-terminal-standing-is-replaced-not-moved.md), [0034](./0034-one-quint-model-per-protocol.md), [0035](./0035-plans-plan-items-and-balance-sources.md), [0037](./0037-a-lifetime-grant-is-a-balance-source.md)

## Context

[0035](./0035-plans-plan-items-and-balance-sources.md) §3 gave a plan a `group`, an `addOn` flag and
an `isDefault` flag, and said at most one active plan per group. The fields are in the catalog. The
rules they imply are not written down, and the model that could check them is one plan wide:
`plans.qnt` keeps a single `plan` field and says so in its header.

Three ordinary product shapes are therefore undescribed:

- A **second group** — a support plan beside a product plan, a seat plan beside a usage plan. Today
  `attach` replaces the one plan, so the second group cannot exist.
- An **add-on** — a plan that stacks beside whatever runs. Today it would take the only slot.
- A **schedule** — "this price for three months, then that one". `ScheduleTierChange` carries one
  `pendingTier`, so it expresses exactly one future move, and it is a field on the standing rather
  than a list.

The questions a reader cannot answer from the code are the ones that decide whether an
implementation is right: what happens to the *other* groups when one moves; what a cancellation does
when it removes the last non-add-on plan; whether a phase may be scheduled for the past; whether two
requests in one operation may each attach into the same group. This record answers them, and
`specs/paykit/schedules.qnt` makes the answers checkable.

## Decision

**1. A plan has a group, and a group holds at most one plan.** A plan without a `group` belongs to
the default group. `attach` names a plan; the plan's group decides what it replaces. A second plan in
the same group is a move, never a second subscription: the plan set is a map from group to one plan,
so `size(group) <= 1` is the shape of the state, not a rule `decide` re-checks.

**2. An add-on stacks beside the plans and fills no slot.** A plan with `addOn: true` is attached
with `addAddOn`, keeps its declared `group` only as catalogue metadata, and never displaces a plan
in any group. Several add-ons may be attached at once; each is its own plan source
([0037](./0037-a-lifetime-grant-is-a-balance-source.md) §2). An add-on survives every move, phase and
cancellation in every group. Only the terminal close removes it (decision 7).

**3. A `PlanSchedule` is an ordered list of phases.** One phase is `{ planId, startsAt }`. The list
is:

- **future-only** — a phase whose instant is not after the scheduling instant is refused
  (`PlanPhaseNotFuture`); a schedule describes what will happen, never what already should have;
- **strictly ordered** — phases are kept sorted by `startsAt`, and two phases at one instant are
  refused (`PlanPhaseAtSameInstant`), so "at most one phase per instant" is a property of the list
  and not a check at application time;
- **bounded** — a deployment states how many phases a schedule may hold; the bound is a limit, not a
  semantic rule, and the model uses two so its state stays small;
- **not group-unique** — two phases may move the same group in turn (an introductory price, then the
  standard one). What is unique is the *instant*, not the group.

The public phase carries `planId` and `startsAt` only. The event that records it carries the plan's
terms, frozen when it was scheduled, for the reason [0012](./0012-a-tier-change-can-be-scheduled-for-the-boundary.md)
§1 gives: the apply runs without the catalogue, so the terms travel with the intent.

**4. A phase moves exactly the group its plan belongs to.** Applying a phase writes that group's
plan and touches nothing else: not the other groups, not the add-ons, not the balance sources. A
phase never names an add-on — a phase replaces a group's plan, and an add-on replaces nothing, so an
add-on's start is its attach (`PlanPhaseNamesAddOn`).

**5. Cancellation replaces the plan with the group's floor, and the floor itself is not
cancellable.** Cancelling a group's plan resolves, at the boundary, to the group's `isDefault` plan
when it states one, and leaves the group empty when it does not. Cancelling the default plan is
refused (`DefaultPlanNotCancelable`): the fallback would be the plan being cancelled, so the
operation would record an intent with no effect.

The reasons, in order:

- A cancellation is a **replacement**, not a vacancy. [0020](./0020-a-terminal-standing-is-replaced-not-moved.md)
  already says a terminal standing is replaced rather than moved; a group whose plan is cancelled is
  the same shape one level down.
- `isDefault` already means "the plan an account gets when it has none". If the last plan in a group
  is cancelled, the account has none, so the group's default is what it gets — in the same
  transaction, before the period rolls.
- A group with **no** default plan is a real shape, not a mistake: the account is left with its
  add-ons, which is exactly the state a one-off pack is spendable in. The account is not terminal
  while another group still holds a plan (decision 7).

A cancellation wins its group's boundary, so it drops every phase the group still had waiting
(`plans.qnt`'s cancellation-wins rule). `uncancel` clears the cancellation; it does **not** restore
the dropped phases, because a phase is an intent the cancellation ended and re-scheduling is an
explicit command.

**6. A move drops the phases its own group had waiting.** An `attach` in a group supersedes the
intents that overlap it, the way a mid-period `ChangeTier` clears `pendingTier`
([0012](./0012-a-tier-change-can-be-scheduled-for-the-boundary.md) §3). Phases belonging to other
groups are untouched. The caller who wants both an immediate move and a later one schedules the
later phase after the move.

**7. A terminal account has no future.** The close ends an account that holds no plan in any group.
An add-on does not keep an account open: there is nothing left to bill and no plan for `check()` to
answer from. A terminal account has no plans, no add-ons, no pending cancellation and no phase, and
every command that would move it is refused (`StandingEnded`, ADR 0020). Replacing it is a new
activation, not a move.

**8. `multiAttach` and `multiUpdate` are one transaction each.** A request may carry several plan
moves: attach into several groups, or update several plan sets (a move, a cancellation and a phase in
one call). Both are:

- **one command id** — the idempotency key names the operation, so a retry replays the whole thing or
  none of it;
- **one set of events** — every event carries the same operation id, so a projection cannot see half;
- **all-or-nothing** — the whole list is validated against the **before** state, and one refusal
  refuses the operation. Two moves into the same group in one operation are `PlanGroupOccupied`,
  because the second would have to replace the first before either is recorded.

**9. A scheduled phase never carries a plan item allowance,** and at its instant the previous plan
source is replaced and the new plan's source is granted ([0035](./0035-plans-plan-items-and-balance-sources.md)
§5, [0037](./0037-a-lifetime-grant-is-a-balance-source.md) §2). The phase moves the plan; the
ledger's own protocol decides what the move does to each source. A lifetime grant and a rollover are
separate sources and survive; the plan's unused allowance does not.

## Consequences

- The plan set is a map from group to plan plus a list of add-ons, not one plan. `attach` is a move
  inside one group; the operation surface gains `addAddOn`, `schedulePlan`, `withdrawPhase` and the
  `multiAttach` / `multiUpdate` requests.
- `PlanSchedule` names the phase list. The `"immediate" | "end_of_cycle"` literal the attach request
  carries today is the one-phase shorthand and is renamed `PlanTiming`: a field that says when one
  move takes effect and a value that lists several phases are different types, and one name for both
  is the second spelling the vocabulary rule refuses.
- `pendingTier` becomes a special case of a schedule: one phase in the plan's group, at the boundary.
  The migration reads an existing `pendingTier` into a one-phase schedule and writes the schedule
  back; nothing about the boundary's ordering (plan change before reset) changes.
- A cancellation no longer ends a plan; it resolves a group. The standing's `canceled` phase is now
  the end of the *last* group, which is the same moment the account becomes terminal.
- A group's `isDefault` is behaviour, not documentation: the catalog is refused when two plans in one
  group each claim it (`CatalogMultipleDefaults`), because a cancellation would not know where to
  land.
- The five existing refusals grow: `PlanPhaseNotFuture`, `PlanPhaseAtSameInstant`,
  `PlanPhaseNamesAddOn`, `PlanGroupOccupied` and `DefaultPlanNotCancelable`, each carrying the plan,
  the group and the instant an operator needs.
- `specs/paykit/schedules.qnt` is the ground truth for the rules above: 11 invariants, 13 mutants and
  27 named scenarios. `pnpm spec:coverage` holds the plan commands against its action table, so a
  move cannot land without a row.

## Alternatives considered

- **One active plan, a list of add-ons.** Rejected: a support plan beside a product plan is not an
  add-on (it has its own default and its own cancellation), and the flat list cannot say which
  replacement a move is competing with.
- **A group per plan, with the group inferred from the plan id prefix.** Rejected: the group is
  product vocabulary, and deriving it from an id makes a rename a behaviour change.
- **Leaving the group empty on every cancellation.** Rejected: `isDefault` would then only be a
  read-time fiction, and an account that cancelled its only plan would need a second command to
  reach the state the catalogue already describes.
- **Falling back to the default even when there is none.** Rejected: it invents a plan the catalogue
  does not declare, and it makes an add-on-only account unrepresentable.
- **A cancellation that keeps the plan until the boundary** — the current `cancelAtPeriodEnd` — for
  the default plan too. Rejected: the default has no boundary worth waiting for, and a no-op
  cancellation is an intent an operator cannot explain.
- **Scheduling the default plan as the fallback.** Rejected: it is the same cancellation spelled
  twice, and it makes "was this cancelled" a question about the plan id rather than about the
  operand.
- **One phase per group.** Rejected: an introductory price followed by a standard one is a chained
  move in one group, and refusing it would push callers back to re-scheduling from a webhook.
- **Per-request command ids in a multi operation.** Rejected: a retry of half an operation is a
  half-applied plan set, and the price the customer holds would not be quotable from either half.
- **Modelling the phase's allowance in this protocol.** Rejected: the source replacement is
  `balances.qnt`'s invariant and the phase only names the plan that replaces them.

## What would reopen this

- A group that must hold **two** plans at once (a base plan plus a required rider that is not an
  add-on). The shape becomes a set per group with a per-group role, and `oneActivePerGroup` becomes
  a statement about roles.
- A cancellation that must be **reversible after the boundary** — an account that wants the plan back
  without a new purchase. That needs a retained plan source and a window, which is a balance-source
  decision before it is a plan decision.
- **Relative** phase instants ("three months after attach") as catalog data, or a phase that
  repeats. Both make the schedule a function of the period rather than a list of instants.
- A phase that must be quoted before it applies, which moves pricing into the schedule and makes the
  frozen terms on the event insufficient.
- A second writer for one account's plan set. [0035](./0035-plans-plan-items-and-balance-sources.md)
  keeps one writer per customer, and every rule above assumes `decide` sees the whole set.
