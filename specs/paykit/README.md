# The paykit models

One Quint model per **protocol**, not one per file ([ADR 0034](../../docs/adr/0034-one-quint-model-per-protocol.md)).
The eight models are the machines `src/Subscription` implements, with the money and the clock
abstracted:

| File | Protocol | What it grounds |
| --- | --- | --- |
| [`paykit.qnt`](./paykit.qnt) | the spend path | activation, counted and credit usage, holds, the pool, the period boundary |
| [`standing.qnt`](./standing.qnt) | the phase machine | trial, grace, dunning, cancellation, a scheduled tier change, the refill budget |
| [`windows.qnt`](./windows.qnt) | the clocks the period does not own | reset windows, a quantity that is set, a cooldown, retry rungs |
| [`plans.qnt`](./plans.qnt) | plan operations | attach classification, upgrade, scheduled downgrade, cancellation, uncancel, reactivation |
| [`schedules.qnt`](./schedules.qnt) | the plan set and its phases | plan groups, the one-plan rule, the add-on, a multi-phase schedule, cancellation, the terminal close |
| [`balances.qnt`](./balances.qnt) | the balance ledger | plan, rollover, expiring and lifetime grants; deduction order; what a close and a plan change preserve |
| [`money.qnt`](./money.qnt) | the money facts | refunds, reversals, tier and quantity proration invoices |
| [`controls.qnt`](./controls.qnt) | customer controls | the spend ceiling, the usage alerts that never refuse, and what a close preserves |

The first is the original spend model; the next seven were added by the lifecycle audit recorded in
[`FINDINGS.md`](./FINDINGS.md), by the plan/balance API and by customer controls. The findings are
the review before any fix; the models are the ground truth for what the fixes should make true.

```sh
pnpm spec          # typecheck every module, then simulate every invariant with its witnesses
pnpm spec:test     # the named scenarios in every *_test.qnt
pnpm spec:mutants  # break one rule at a time across all eight models and prove an invariant notices
pnpm spec:coverage # hold the eight models' actions against every command
```

## Run it

`quint run` samples traces; it does not prove. A green run means "no violation in 10 000 walks of up
to N steps", which is a different claim from the property suite's 100 walks of up to 80 sequential
steps: the models let the clock, the sweep and a command interleave freely, and the property suite
never does.

`quint verify` (Apalache) is not wired to a gate. It needs a JVM and minutes, and the shared modelling
discipline is to reach for it only when someone asks to model-check a specific property. When that
happens, run it by hand and record the command and the bound in this file.

## The implicit state machines

The inventory the audit started from. A machine is "implicit" when the code carries its state in
optional fields and guards rather than one named transition table; `StandingPhase.ts`,
`HoldPhase.ts` and `Webhooks.ts` are the three places a table already exists, and the models are how
the rest became checkable.

| Machine | Where it lives | Model | State |
| --- | --- | --- | --- |
| standing phase (`trialing`/`active`/`grace`/`expired`/`canceled`) | `Subscription.state.ts`, `StandingPhase.ts` | `standing.qnt` | modelled |
| trial latch and deadline | `StartTrial`, `ExtendTrial` | `standing.qnt` | modelled |
| dunning run, attempts and grace deadline | `RecordPaymentFailure`, `DunningRetry`, `Dunning.policy.ts` | `standing.qnt` | modelled |
| scheduled cancellation | `cancelAtPeriodEnd`, `ScheduleCancellation`, `Resume` | `standing.qnt`, `schedules.qnt` | modelled |
| scheduled tier change | `pendingTier`, `ScheduleTierChange`, `WithdrawTierChange` | `standing.qnt`, `plans.qnt`, `schedules.qnt` | modelled (plan operations) |
| plan set and groups | `group`, `addOn`, `isDefault`, `attach`, `addAddOn` | `schedules.qnt` | modelled |
| multi-phase schedule | `PlanSchedule`, the phase instant, the scheduler | `schedules.qnt` | modelled |
| auto top-up failure budget and retry rungs | `TopUpFailed`, `RetryTopUp`, `AutoTopUp.policy.ts` | `standing.qnt`, `windows.qnt` | modelled |
| auto top-up cooldown | `topUpCooldownUntil`, `TopUpCooldownElapsed` | `windows.qnt` | modelled |
| per-feature reset windows | `resetAt`, `ResetAllowance`, `AllowanceRollover.policy.ts` | `windows.qnt` | modelled |
| quantity (seat) state | `quantities`, `SetQuantity`, seat usage | `windows.qnt` | modelled (purchased vs occupied) |
| balance grants and expiry | `grants`, `GrantBalance`, `ExpireGrant`, `BalanceExpiry` | `balances.qnt` | modelled |
| customer spend ceiling and usage alerts | `controls`, `SetBillingControls`, `UsageAlertReached` | `controls.qnt` | modelled |
| tier proration state | `proration`, `prorationId`, `ChangeTier`, `RecordProrationInvoice` | `money.qnt` | modelled |
| quantity proration state | `quantityProrations`, `SetQuantity`, `RecordQuantityProrationInvoice` | `money.qnt` | modelled |
| refund and reversal state | `charged`, `refunded`, `refunds`, `Refund`, `ReverseRefund` | `money.qnt` | modelled |
| hold lifecycle | `holds`, `HoldPhase.ts` | `paykit.qnt` | modelled (spend path) |
| webhook edge | `WEBHOOK_TRANSITIONS` in `Webhooks.ts` | — | total table; not modelled (provider edge) |
| outbound delivery | `Outbound.policy.ts` | — | at-least-once transport, no model state |
| migrations and consumer generations | `Migrations/index.ts`, `SqlPlatform.ts` | — | Domain's registry/backfill owns it |
| admin console UI states | `LoadState`, `AnswerState`, `FeedState`, `PendingStatus` | — | UI state, not billing state |
| Alchemy resource lifecycle | `paykit-stripe`, `paykit-polar` resource providers | — | the engine/provider owns it |

## The spend path (`paykit.qnt`)

| Action | Source | Event it records |
| --- | --- | --- |
| `subscribe` | `Subscribe.command.ts` | `SubscriptionActivated` |
| `trackUsage` | `TrackUsage.command.ts` | `UsageRecorded` |
| `consumeCredits` | `ConsumeCredits.command.ts` | `CreditsConsumed` |
| `hold` | `Hold.command.ts` | `UsageReserved` |
| `settleHold` | `SettleHold.command.ts` | `UsageRecorded` + `UsageSettled` |
| `releaseHold` | `ReleaseHold.command.ts` | `UsageReleased`, reason `released` |
| `expireHold` | `HoldElapsed.command.ts` | `UsageReleased`, reason `expired` |
| `closePeriod` | `ClosePeriod.command.ts`, `PeriodEnded.command.ts` | `UsageReleased` (reason `reset`), `PeriodClosed`, `UsageReset`, `CreditsExpired` |
| `enterGrace` | `EnterGrace.command.ts` | `GraceEntered` |
| `recover` | `Recover.command.ts` | `Recovered` |
| `cancelStanding` | `ScheduleCancellation.command.ts`, `Expire.command.ts` | `CancellationScheduled`, `SubscriptionExpired` |
| `tick` | the platform clock the policy scheduler runs on | — |

| Invariant | What it says | ADR |
| --- | --- | --- |
| `countedConserved` | `remaining + used + reserved == included + carried`, for every counted feature | 0004, 0009 |
| `noNegativeUsage` | usage only moves forward | 0008 |
| `blockingNeverOversubscribed` | a `block` allowance's remaining never goes below zero; `bill` may pass `included` | 0009 |
| `carriedIsBounded` | a boundary carries at most the cap, and an allowance that does not roll over carries nothing | 0001, 0022 |
| `creditsCoverEveryHold` | the pool covers every open hold, so settle always has credits to bill | 0002, 0004 |
| `creditPoolConserved` | `credits + spent + consumed + expired == granted` | 0002 |
| `holdCostIsAmountTimesRate` | a hold's reservation is its units times the rate it captured | 0004 |
| `noHoldPastDeadline` | the clock never passes an open hold's deadline | 0021 |
| `noPeriodPastEnd` | the clock never passes the boundary with the period still open | 0012 |

The one finding the first model recorded is still true: a credit-priced feature's stored
`remaining` is a cache that `ConsumeCredits` leaves stale. Nothing observable reads it, so
`spendableOf` derives it from the pool instead of asserting a field only the model can see.

## The standing (`standing.qnt`)

`unsubscribed → trialing → active → grace → expired | canceled` is the phase; the model keeps the
lifetime trial latch, the dunning run identity, the cancellation flag and the pending tier beside it.

| Action | Source |
| --- | --- |
| `startTrial`, `subscribe`, `extendTrial` | `StartTrial`, `Subscribe`, `ExtendTrial` |
| `enterGrace`, `failPayment`, `recordPayment`, `recover` | `EnterGrace`, `RecordPaymentFailure`, `RecordPayment`, `Recover` |
| `graceElapsed`, `expire` | `GraceElapsed`, `Expire` |
| `scheduleCancellation`, `resume` | `ScheduleCancellation`, `Resume` |
| `scheduleTier`, `withdrawTier`, `changeTier` | `ScheduleTierChange`, `WithdrawTierChange`, `ChangeTier` |
| `closePeriod` | `ClosePeriod`, `PeriodEnded` |
| `dunningRung` | `DunningRetry` |
| `failTopUp`, `buyTopUp`, `topUpRung`, `spendCredits` | `RecordTopUpFailure`, `PurchaseCredits`, `RetryTopUp`, `ConsumeCredits` |
| `tick` | the platform clock |

Invariants: `creditPoolConserved` (plan and lifetime sources are each a fold), `trialingImpliesTrialUsed`,
`graceHasDeadline`, `noGracePastDeadline`, `noPeriodPastEnd`, `cancellationBelongsToAStanding`,
`dunningAttemptsHaveARun`, and `creditsNeverNegative`. A lifetime grant is a separate source and
survives a close or a scheduled change; a plan's credits are replaced at the boundary (ADR 0037).

The refill budget is per episode. A failure opens an episode, a success or a boundary starts a fresh
budget, and a retry names the episode and the attempt it belongs to — the model's `topUpEpisode` is
the field the implementation does not have (finding F5).


## The plan operations (`plans.qnt`)

`attach` turns one request into an activation, an immediate upgrade, a scheduled downgrade or a
no-op. A downgrade waits for the boundary unless the caller asks for it now. `update` carries the
cancellation, the uncancel and the immediate cancellation. The model keeps one active plan; the plan
set, its groups and the multi-phase schedule are [`schedules.qnt`](./schedules.qnt), and this model
is the classification an operation performs before either writes.

| Action | Source |
| --- | --- |
| `attach` | `Subscribe`, `ChangeTier`, `ScheduleTierChange` |
| `cancelAtBoundary` | `ScheduleCancellation` |
| `uncancel` | `Resume`, `WithdrawTierChange` |
| `cancelImmediately` | the immediate branch of an update operation |
| `close` | `ClosePeriod`, `PeriodEnded` |
| `tick` | the platform clock |

Invariants: `activePlanIsKnown`, `scheduledChangeIsADowngrade`, `pendingIsNotCurrent`,
`terminalHasNoIntent`, `noPlanHasNoIntent`, `noPeriodPastEnd`.

A cancellation wins the boundary and drops a pending change. An uncancel clears whichever intent is
pending. An immediate cancellation clears both. A canceled plan can be bought again; that is a new
activation, not a reopen.

## The plan set and schedules (`schedules.qnt`)

[ADR 0039](../../docs/adr/0039-one-plan-per-group-and-add-ons-stack.md) is the record. Two groups,
two plan choices in each, one add-on, a schedule that holds at most two phases, and a step counter
where the implementation has a clock. Group A states a default plan; group B states none, so both
halves of the cancellation rule are reachable. The state is the plan set — `plans.qnt` is the
classification of one move, `standing.qnt` is the phase machine, `balances.qnt` is what a move does
to the sources behind a count, and this model is which plan occupies which slot and when.

| Action | Source | Move it makes |
| --- | --- | --- |
| `attach` | `Subscribe`, `ChangeTier` | a new plan or a replacement in the plan's group |
| `addAddOn` | the add-on branch of an attach operation | sets the add-on beside every group |
| `schedulePlan` | `ScheduleTierChange` | appends a future, ordered phase |
| `withdrawPhase` | `WithdrawTierChange` | drops a phase that has not fired |
| `applyPhase` | the scheduler at a phase's `startsAt` | moves one group, at that instant |
| `cancelGroup` | `ScheduleCancellation` | a cancellation waiting for the boundary |
| `uncancelGroup` | `Resume` | withdraws the cancellation, not the dropped phases |
| `cancelNow` | `CancelImmediately` | the same resolution, performed now |
| `close` | `ClosePeriod`, `PeriodEnded` | resolves pending cancellations, rolls the period, ends an empty account |
| `tick` | the platform clock | stops at a due phase and at the boundary |

| Invariant | What it says | ADR |
| --- | --- | --- |
| `oneActivePerGroup` | a group holds at most one plan, so a move replaces rather than adds | 0035 §3, 0039 §1 |
| `addOnsStack` | a group slot holds a plan of that group; the add-on fills no slot | 0039 §2 |
| `addOnsSurviveGroupChange` | an add-on attached to an open account stays attached | 0039 §2 |
| `phasesAreFuture` | no pending phase is behind the clock; the clock stops at a due phase | 0039 §3 |
| `phasesAreOrdered` | phases start in strictly increasing order, so at most one per instant | 0039 §3 |
| `phaseNeverSkipsAGroup` | a phase names a group's plan, never the add-on, and changes that group alone | 0039 §4 |
| `cancelNeverNamesTheDefault` | the floor of a group is not cancellable | 0039 §5 |
| `cancelFallsBackToTheDefault` | a resolved cancellation lands the group on its default plan | 0039 §5 |
| `noPlanAfterCancel` | a group with no default is left empty, and the add-ons stay | 0020, 0039 §5 |
| `noPeriodPastEnd` | the clock stops at the boundary; the close is the only way past it | 0012, 0039 §7 |
| `terminalHasNoIntent` | a terminal account has no plan, add-on, cancellation or phase | 0020, 0039 §7 |

Three decisions are visible in the model and worth reading beside the ADR. A **move drops the
phases its own group had waiting** and leaves the other group's alone, because a phase is an intent
relative to the plan it replaces (ADR 0012 §3). A **cancellation wins its group's boundary** and
drops that group's phases; an uncancel does not bring them back. And a **phase is applied at its
exact instant**, so the model's clock refuses to tick past a due phase — a phase that would have
been applied late is a violation, not a later repair.

What the slice deliberately leaves out:

- **The allowance a phase grants.** A phase names a plan; replacing the plan source is
  `balances.qnt`'s rule (ADR 0035 §5, ADR 0037 §2). This model only asserts the plan changed.
- **`multiAttach` and `multiUpdate`.** They are one transaction, one command id and one set of
  events (ADR 0039 §8), which the command layer and `Idempotence.test.ts` own. A model of "two
  requests, one commit" is a transaction shape, not a plan-set rule.
- **Pricing and proration.** A phase's frozen terms are the event's, and the amounts are
  `Pricing.test.ts` and `Proration.test.ts`.
- **Two add-ons.** The model has one, because the invariant is "an add-on fills no slot", not the
  cardinality. Several add-ons collapse into the same rule.
- **The `isDefault` validation.** That two plans in one group cannot both claim the default
  (`CatalogMultipleDefaults`) is a catalogue rule, so it is `Catalog.test.ts`'s.

## The windows (`windows.qnt`)

The boundary the period does not own, the count that is bought rather than spent, and the two
deadlines a refill uses. A seat has a **purchased** quantity and an **occupied** count; the
balance is `purchased - occupied` and may be negative. A purchase may drop below occupancy and a
plan change may leave the account above its purchase cap; neither removes an occupied seat.

| Action | Source |
| --- | --- |
| `track` | `TrackUsage` (the count effect) |
| `resetWindow` | `ResetAllowance` |
| `closePeriod` | `ClosePeriod` (`UsageReset`, kept features) |
| `setQuantity` | `SetQuantity` |
| `setUsage` | `SetUsage` (occupancy, and the read `check` uses) |
| `changeTierCap` | `ChangeTier` (quantity branch) |
| `spendCredits` | `ConsumeCredits` (the pool effect) |
| `failTopUp`, `fireRung`, `buyTopUp`, `cooldownElapsed` | `RecordTopUpFailure` + `AutoTopUp`, `RetryTopUp`, `PurchaseCredits`, `TopUpCooldownElapsed` |
| `endStanding`, `tick` | `Expire`/`GraceElapsed`, the platform clock |

Invariants: `seatCountsNonNegative`, `seatBalanceIsDerived`, `seatCheckAgreesWithBalance`,
`blockingCountsBounded`, `boundariesAdvance`, `rungsBelongToTheBudget`,
`topUpAttemptsWithinBudget`, `noWindowResetAfterEnd`, `noRungFiredAfterEnd`,
`cooldownHasADeadline`, `creditsNeverNegative`.

Two deliberate decisions are visible here. A late reset starts the next window where it actually
fired, not where the boundary was. And a period close resets only the windows whose boundary is the
period; a daily allowance is left alone. Both are pinned by `windows_test.qnt`.

## The balance ledger (`balances.qnt`)

One counted feature's balance is a plan source, a rollover, and two classes of grant. The model
keeps the plan's include count fixed, a cap on the rollover, and one expiring and one lifetime
grant; the cardinality is not the invariant, the order is.

| Action | Source | Event |
| --- | --- | --- |
| `createGrant` | `GrantBalance` / `balances.create` | `BalanceGranted` |
| `spend` | `TrackUsage`, and a hold's reservation | `UsageRecorded`, `UsageReserved` |
| `closePeriod` | `ClosePeriod`, `ResetAllowance` | `UsageReset`, `PlanItemReset` |
| `changePlan` | `ChangeTier` / `ScheduleTierChange` | `PlanChanged` |
| `expireGrant` | `BalanceExpiry.policy.ts` / `ExpireGrant` | `BalanceExpired` |
| `tick` | the platform clock | — |

Invariants: `sourcesNonNegative`, `totalNonNegative`, `grantSpentOnlyAfterPlan` (a grant was
touched only when the plan and rollover were empty), `rolloverBounded`, `carriedWithinCap`,
`expiringConserved` (an expiring grant's units are spent or expired, never dropped),
`lifetimeConserved` (a close or plan change cannot destroy a lifetime grant), and `expiryIsFinal`.

The model collapses credits into the plan source. A credit-priced feature's pool is still
`credits` + `prepaidCredits` in the code; its `Balance.breakdown` is derived from those two, not
from a stored source. That is the next refinement, not a rule this model states.

## The money (`money.qnt`)

| Action | Source | Event |
| --- | --- | --- |
| `charge` | `PurchaseCredits` / `RecordPayment` | `CreditsPurchased` / `PaymentRecorded` |
| `refund` | `Refund` | `RefundRecorded` |
| `reverse` | `ReverseRefund` | `RefundReversed` |
| `changeTier` | `ChangeTier` | `PlanChanged.proration` |
| `invoiceProration` | `RecordProrationInvoice` | `ProrationInvoiced` |
| `setQuantity` | `SetQuantity` | `QuantityChanged.proration` |
| `invoiceQuantity` | `RecordQuantityProrationInvoice` | `QuantityProrationInvoiced` |

Invariants: `refundsCoveredByCharges`, `refundedIsOutstanding` (the total is the fold of the
records), `reversalsBounded`, `refundAmountsArePositive`, `billedProrationIsPositive`,
`lastInvoiceMatchesBilled`, `billedProrationIsCurrent` (a stale id cannot settle a newer change),
`quantityCreditsNeverInvoiced`, `quantityInvoicesMatchDue`, `invoicedIsPartOfCharged`.

`canInvoiceProration` is the whole identity rule: an invoice names the current proration's id and
its due. `canInvoiceQuantity` adds the one the implementation's command layer is missing: a credit
(`due < 0`) is never invoiced, and the invoice amount is the due.

## The mutants

`pnpm spec:mutants` kills 63 mutants across the eight models: 17 for the spend path, 3 for the
standing, 6 for the windows, 4 for the plan operations, 13 for the plan set and its schedules, 7 for
the balance ledger, 7 for the money protocol and 6 for customer controls. Each mutant is a textual
replacement and
the gate fails when an invariant **survives** it. The new models' mutants are the same discipline as
the original: an invariant with nothing behind it is a claim, not a check.

One rule is **not** an invariant: "a terminal standing may not settle". It conserves every counter,
so only `cancelRefusesSettleTest` catches it — the two halves check different things on purpose.

## What these models do not reproduce

- **The read model.** `Entitlements`, `BillingState`, and every projection are folds over the same
  events and are compared against the aggregate by `test/properties/Agreement.test.ts`.
- **Idempotence.** A retried command is a no-op by command id; `Idempotence.test.ts` and the command
  ids carry it. A `dedupeKey` is a second, command-level replay key; the models name it once where
  the identity matters.
- **The webhook edge.** `WEBHOOK_TRANSITIONS` is a total table already; the provider's four kinds
  and six phases are a dispatch, not a state machine the billing aggregate owns. The audit left it
  out rather than model a vendor's delivery order.
- **Currency.** `money.qnt` uses one unit. The per-currency refund ceiling is `Refund.test.ts`'s job;
  adding a second dimension would not change the identity rules.
- **Money arithmetic.** Proration amounts, branch prices, tax and currency conversion are
  `Pricing.test.ts` and `Proration.test.ts`. The model says when an invoice may settle a change, not
  how much the change is.
- **Tier catalogue and ceilings.** `ChangeTier`'s `downgradeOf` ceilings are property-tested by
  `Invariants.test.ts`; the standing model covers the lifecycle, not every money ceiling.
- **The vendor resources.** `paykit-stripe` and `paykit-polar` own Alchemy resource lifecycles; they
  are a separate model if their archive/retain rules become the question.

## Findings

[`FINDINGS.md`](./FINDINGS.md) is the review: the machines that had no model, the twelve
divergences the audit found, and the notes that are not defects. Do not fix a finding by editing
a model to match the code: the model is the intended rule, and the finding is the divergence.

## When to update this

The models are the ground truth for the invariants they name and for nothing else. When a command
changes what it accepts or what it writes, update the model and run `pnpm spec` **before** changing
the command — a red model is cheaper than a red deploy. When a new command touches a phase, a
counter, a window, a quantity or a money fact, it is in scope: add the action, its witness, its
`run`, and either an invariant or a note here saying why it has none. `pnpm spec:coverage` fails a
command with no row, so the decision is one row per command rather than a silent omission.


## Customer controls (`controls.qnt`)

One counted feature's money ceiling for a period, and the alert that records a crossing without
refusing anything. The model is deliberately small: it says when a charge is refused and when an
alert may fire, not how a price is computed. The auto top-up override is a pure read — the
customer's line when present, otherwise the standing plan's — and a pure function is a unit test,
not a protocol.

| Action | Source | Event |
| --- | --- | --- |
| `setControls`, `clearControls` | `SetBillingControls` | `BillingControlsSet` |
| `track` | `TrackUsage` (the accepted branch), and a hold's admission | `UsageRecorded` |
| `refuse` | the refused branch of `TrackUsage` and `Hold` | the typed refusal, no event |
| `fireAlert` | the usage fact that reaches the threshold | `UsageAlertFired` |
| `closePeriod` | `ClosePeriod`, `PeriodEnded` | `PeriodClosed` |
| `tick` | the platform clock | — |

Invariants: `limitIsACeiling`, `alertFiresOncePerPeriod`, `alertOnlyAtOrPastItsThreshold`,
`limitSurvivesAClose`, `noTrackPastPeriod`.

Three decisions are visible here. A ceiling may be lowered under money already billed: it stops new
spend and never unbills history, so `billed <= limit` is allowed to be false only in that state. A
refusal is the command's other branch, so `track(100).fail()` proves the accept-set and `refuse(100)`
records the refusal. An alert is evidence: it latches once per period, resets at a close, and never
moves a counter.

What the slice leaves out: the auto top-up override (a read, tested in the unit suite), a ceiling
that spans features or the whole account (it is per feature, because a money ceiling needs a price),
a limit over a seat purchase, and a retry budget for a failed refill (`standing.qnt` models it).
