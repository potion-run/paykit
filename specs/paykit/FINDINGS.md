# Findings — implicit state machines and the divergences the models expose

**Status:** all twelve findings are addressed. F1, F2, F3 and F6 are
implemented in code with tests in the finding's shape; F4, F5 and F7 were fixed by
[0036](../../docs/adr/0036-a-seat-is-purchased-and-occupied.md),
[0031](../../docs/adr/0031-a-failed-top-up-retries-on-a-budget.md) and
[0037](../../docs/adr/0037-a-lifetime-grant-is-a-balance-source.md); F9 is fixed by
[0042](../../docs/adr/0042-a-quantity-credit-settles-the-next-charge.md); and F8, F10, F11
and F12 are fixed by the terminal reset guard, the cleared schedule, the forward-only
grace deadline and cancellation winning the boundary. The nine models are green
(`pnpm spec`, `pnpm spec:test`, `pnpm spec:mutants`, `pnpm spec:coverage`).

The method was:

1. Read every state-carrying field and every guard in `src/Subscription` and list the machines they
   imply (the inventory in [README.md](./README.md#the-implicit-state-machines)).
2. Model the intended protocol for the ones that had no model: `standing.qnt`, `windows.qnt`,
   `money.qnt`. `paykit.qnt` already covered the spend path.
3. Drive the current code through the same scenarios with the pure `decide`/`evolve` helpers in
   `test/properties/Arbitraries.ts`. The probes are throwaway scripts; the outputs below are the
   evidence.
4. Check each model with witnesses, named scenarios, and mutants. A finding is a state the code
   reaches that the model's action guards or invariants say it must not.

Severity is about customer money or a state no later command can explain, not about line count.

| ID | Finding | Severity |
| --- | --- | --- |
| F1 | `RecordProrationInvoice` has no proration identity and trusts its amount/currency | critical |
| F2 | A quantity proration invoice can be a credit, an arbitrary amount, and is not added to `charged` | critical |
| F3 | Reusing a `SetQuantity` dedupe key overwrites a billed proration and can bill again | high |
| F4 | A seat balance is derived from the purchase cap, not from purchased minus occupied | high |
| F5 | A stale top-up retry rung can fire after a success and a new failure | high |
| F6 | `PlanChanged` does not reset the refill budget, contrary to ADR 0031 | high |
| F7 | A plan allowance and a lifetime grant are the same field, so a scheduled change cannot tell them apart | high |
| F8 | `ResetAllowance` resets counters and holds of a terminal standing | medium |
| F9 | A seat reduction's credit is recorded and never applied | medium |
| F10 | A pending tier survives terminal expiry | low |
| F11 | Grace accepts a deadline at or before `now` | low |
| F12 | A cancellation and a pending tier both apply at the same close | low |

**Current status (2026-11).** F4, F5 and F7 are fixed by [ADR 0036](../../docs/adr/0036-a-seat-is-purchased-and-occupied.md),
[ADR 0031](../../docs/adr/0031-a-failed-top-up-retries-on-a-budget.md) and
[ADR 0037](../../docs/adr/0037-a-lifetime-grant-is-a-balance-source.md). F1, F2, F3 and F6 are
fixed by the `prorationId` on `RecordProrationInvoice`/`ProrationInvoiced`, the due/currency guard and
`charged` fold on `QuantityProrationInvoiced`, the `QuantityProrationAlreadyBilled` refusal on
`SetQuantity`, and the `topUpAttempts: 0` reset in the `PlanChanged` fold. F8, F10, F11 and F12 are
fixed by a terminal guard on `ResetAllowance`, clearing the schedule on terminal expiry and a
canceling close, a forward-only grace deadline (`GraceDeadlineNotLater`), and cancellation winning the
boundary. F9 is fixed by [ADR 0042](../../docs/adr/0042-a-quantity-credit-settles-the-next-charge.md):
`ApplyQuantityCredit` spends a negative `due` against the next quantity charge, capped by that
charge and never paid out. Tests: `test/billing/InvoiceIdentity.test.ts`,
`test/billing/QuantityCredit.test.ts`, `test/standing/Findings.test.ts`,
`test/properties/Quantities.test.ts`, and the named `standing_test.qnt` and `money_test.qnt`
scenarios.

**Audit (2026-11).** The F1, F2, F3, F6, F8, F10, F11 and F12 probes were re-run against the merged
code. All eight are still fixed: F1's stale id and arbitrary amount are `ProrationInvoiceMismatch`;
F2's credit is `QuantityProrationNotBillable`, its wrong amount is `QuantityProrationMismatch`, and a
valid invoice folds into `charged`; F3's reused key is `QuantityProrationAlreadyBilled` while a
same-quantity retry is a no-op; F6 resets `topUpAttempts` and keeps the failure; F8's terminal reset
is a no-op; F10 leaves an expired standing with no schedule and no `pendingTier`; F11 refuses a
lapsed `EnterGrace` and records no stale failure; F12 closes canceled on the plan the account was
on, with no `PlanChanged`. No status line needed correcting.

---

## F1 — a proration invoice is not tied to the proration it settles

**Where:** `src/Subscription/Subscription.aggregate.ts` `RecordProrationInvoice`
(`state.proration`, `state.prorationInvoice`), `ProrationInvoiced` evolve.

**Model:** `money.qnt` `canInvoiceProration` requires `entry.id == id`, `entry.due == amount`, and
`entry.due > 0`; `billedProrationIsCurrent` requires the billed id to be the latest change.

**What happens.** `RecordProrationInvoice` checks only that the *current* proration is positive and
has not been invoiced. It does not read a proration id, an expected amount, or an expected currency.
The event records whatever the caller sent. Two consequences:

- A tier change replaces the proration (`PlanChanged` clears `proration`, `prorationInvoice`, and
  `prorationId`). An invoice opened for the old change can then be recorded against the new one.
  With `B` at due 103 and then `C` at due 51, the old 103 invoice is accepted and `C` is marked
  billed while 51 was owed:

  ```text
  3 B due 103 id 1
  3 C due 51 id 2 oldId 1
  3 bill B's invoice amount against C ProrationInvoiced
  3 charged { usd: 103 } invoice in_old C due 51
  ```

- The amount and currency are unvalidated. The same state accepts a 999999 EUR invoice for a 154
  USD proration:

  ```text
  3 arbitary invoice ProrationInvoiced due 154
  ```

The binding (`ChargeProration.operation.ts`) computes the right id, amount and currency, but the
command is on the admin surface and the aggregate is the last line of defence. A retry that races a
tier change, or a direct caller, reaches the state above.

**Why it matters:** the log says a charge was collected that does not match the change it names.
A read model and a refund ceiling both trust `charged`; a customer can be underbilled or overbilled
with no event that says which change the money belonged to.

**Proposed fix:** give `ProrationInvoiced` a `prorationId` (the `PlanChanged` event already has one),
require the current `prorationId` to match, and require `amount == proration.due` and
`currency == proration.currency`. `RecordQuantityProrationInvoice` is the precedent: it already
carries the id.

**Fixed.** `ProrationInvoiced` and `RecordProrationInvoice` carry `prorationId`; `decide` refuses a
stale id or a different amount/currency with `ProrationInvoiceMismatch`, and
`test/billing/InvoiceIdentity.test.ts` pins the two probes above.

---

## F2 — a quantity invoice can be a credit, can be any amount, and never reaches `charged`

**Where:** `src/Subscription/Subscription.aggregate.ts` `RecordQuantityProrationInvoice` and
`QuantityProrationInvoiced` evolve; `QuantityProration.command.ts`.

**Model:** `money.qnt` `canInvoiceQuantity` requires `entry.due > 0`, `entry.due == amount`, and
`not(entry.invoiced)`; `invoiceQuantity` adds the amount to `charged` and `invoiced`.

**What happens.** The command checks that the entry exists and has no invoice id. It does **not**
check `due > 0` or that the amount/currency match the entry. The binding does check `due > 0`, but
the command is the model boundary and an admin caller goes straight to it. A reduction is recorded
with a negative `due`; the command accepts an invoice for it:

```text
4 entry due -80
4 bill credit QuantityProrationInvoiced
```

The amount is also unchecked, so an invoice for 70 can settle an 80 due. And `QuantityProrationInvoiced`
evolve only writes `invoiceId`; unlike `ProrationInvoiced`, it never calls `chargedWith`. After an
80 credit is invoiced, `state.charged` is still unset:

```text
4 … charged undefined after a quantity invoice for the same key
```

**Why it matters:** a seat reduction can be billed as money the customer owes, and a real seat
invoice is invisible to `refundableOf` — a later refund is refused for money the log recorded as
charged. The `QuantityProration.command.ts` and `ChargeQuantityProration.binding.ts` split is the
reason the binding's guard looked sufficient.

**Proposed fix:** move the `due > 0` and amount/currency checks into `decide`; fold
`QuantityProrationInvoiced.amount` into `charged` exactly as `ProrationInvoiced` does.

**Fixed.** `decide` refuses a credit with `QuantityProrationNotBillable` and a mismatched amount or
currency with `QuantityProrationMismatch`; `QuantityProrationInvoiced` folds into `charged`. The
credit and `charged` probes are in `test/billing/InvoiceIdentity.test.ts`.

---

## F3 — a reused quantity key overwrites a billed proration

**Where:** `SetQuantity`/`QuantityChanged` (`quantityProrations[prorationId]`), and the quantity
`RecordQuantityProrationInvoice`.

**Model:** `money.qnt` `setQuantity` is disabled when the key already has an entry; a key owns one
change.

**What happens.** `SetQuantity` treats `dedupeKey` as the proration id, but it does not check that
the key is unused. A retry with the same key and a different quantity records a new
`QuantityChanged`, and `evolve` overwrites the entry — including an existing `invoiceId`:

```text
set10 QuantityChanged            entry1 due 80
after invoice1                   invoiceId in1
set5 same key QuantityChanged    entry2 due -50
invoice2 same key QuantityProrationInvoiced
```

The first invoice is now erased from the proration record. With F2's missing `due > 0` guard, the
same call also invoices the -50 credit.

**Why it matters:** the command's own contract says a retry is one change; a key reused for a
different quantity is accepted as a second change, loses the first invoice's evidence, and can
charge twice under one key.

**Proposed fix:** `SetQuantity` refuses (or ignores) a `dedupeKey` that already has an entry with a
different quantity. Treat the entry as immutable: a new quantity is a new key, and a retry is a
replay only when the quantity is the same.

**Decision.** A retry with the same quantity records nothing (it never reaches the key check because
the quantity did not move). A different quantity under an existing key is refused with
`QuantityProrationAlreadyBilled`, carrying the entry's `invoiceId` when it has one. [ADR
0023](../../docs/adr/0023-a-seat-is-a-quantity-that-is-set.md) records the rule, and
`test/billing/InvoiceIdentity.test.ts` pins the double-bill probe.

---

## F4 — a seat balance is derived from the purchase cap, not from occupancy

**Where:** `Subscription.state.ts` `remaining` for a non-consumable feature,
`Subscription.aggregate.ts` `startingRemaining`, `remainingAfterChange`, `PlanChanged` evolve, and
`Allowance.verdict.ts` `capacityOf` (`cap - quantity`).

**Model:** `windows.qnt` `seatBalance` is `purchased - occupied`; `setQuantity` may set the
purchase below occupancy; `setUsage` writes occupancy independently.

**What happens.** The state has one seat number. `SetQuantity` writes it, and `remaining` is
`cap - quantity` or `Math.max(0, cap - quantity)`. There is no occupied count, so the code cannot
represent the ordinary state "five people are in the workspace, the customer bought three seats".
Lowering the purchase below occupancy is either clamped, refused, or silently treated as fewer
seats in use. A plan change that lowers the cap clamps `remaining` to zero and hides that the
account is over its purchase ceiling.

```text
5 change PlanChanged
5 quantity 10 cap 5
```

The read model says "10 seats, cap 5"; the balance says zero, not negative. The implementation
cannot answer whether a new person may join.

**Decision:** [0036](../../docs/adr/0036-a-seat-is-purchased-and-occupied.md) separates
`purchased` and `occupied`. `remaining` may be negative; `check()` blocks new occupancy while it
is negative; an occupied seat is never removed by a purchase or plan change. `cap` is a purchase
ceiling, not a `remaining` formula.

**Proposed fix:** add `purchased` and `occupied` to the state and read model, add `SetUsage`, and
change `remaining` to `purchased - occupied`. `SetQuantity` keeps the cap guard; `ChangeTier` no
longer clamps or refuses on the new cap.

## F5 — a stale top-up rung can fire after a success and a new failure

**Where:** `RetryTopUp` decide (`topUpAttemptsOf(state) !== command.attempt`), `AutoTopUp.policy.ts`
(the `topUpRetryCommandId`/`attempt` schedule), `TopUpFailed.attempt`.

**Model:** `standing.qnt` `canTopUpRung` requires the episode **and** the attempt;
`windows.qnt` `failedTopUp` clears the old queue and `rungsBelongToTheBudget` requires every queued
rung to belong to the current episode.

**What happens.** The retry command compares only the attempt number. After a success resets
`topUpAttempts` to 0, a new failure starts a new episode at attempt 1. The old episode's rung is
also `attempt: 1`, so it is accepted:

```text
attempts after fail1 1
attempts after buy 0
attempts after fail2 1
old episode rung attempt 1: ACCEPT[TopUpRetryDue]
```

ADR 0031 §3 says a success "resets the counter and every outstanding rung is stale"; §5 says the
counter is the identity. The implementation has no episode id, so the identity is only the number
that resets.

**Why it matters:** a customer can receive one more provider call than the budget allowed, and the
log cannot say which episode the rung belonged to.

**Proposed fix:** carry an episode identity (the failure's `at`, or a run counter) on `TopUpFailed`
and `RetryTopUp`, and compare both. The dunning path already does this with `dunningStartedAt`.
Clearing old rungs when a new episode starts is the second half of the same rule.

---

## F6 — a tier change does not reset the refill budget

**Where:** `Subscription.aggregate.ts` `PlanChanged` evolve (destructures the old top-up fields but
never writes `topUpAttempts`).

**Model:** `standing.qnt` `changeTier` sets `topUpAttempts: 0`.

**What happens.** A standing with one failed refill changes tier; the failure count survives:

```text
6b attempts before tier change 1
6b change PlanChanged
6b attempts after tier change 1 failure still true
```

ADR 0031 §5 says `PlanChanged` resets the count "because each re-establishes the line or the pool —
a fresh line with a new pool deserves a fresh budget". `SubscriptionActivated` and `PeriodClosed`
do reset it; `PlanChanged` is the missing one.

**Why it matters:** a tier that names a new line and pack inherits a spent budget from the old line,
so its retries are suppressed exactly when a deployment moved it to a line that should try.

**Proposed fix:** set `topUpAttempts: 0` in `PlanChanged` (keep `topUpFailure` as history, per ADR
0027), and add the story/property that pins it.

**Fixed.** `PlanChanged` resets `topUpAttempts` to zero and leaves `topUpFailure` in place;
`test/standing/Findings.test.ts` records the probe.

---

## F7 — a plan allowance and a lifetime grant are the same field

**Where:** `closePeriodEvents` (`const credits = pending === undefined ? state.credits :
pending.credits + prepaid`; `const expiring = pending === undefined ? expiringCreditsOf(state) : 0`),
`Subscription.state.ts` `creditsExpire`, and the `prepaidCredits` special case.

**Model:** `standing.qnt` keeps `planCredits` and `lifetimeCredits` as separate folds;
`lifetimeCreditsSurviveClose` and `lifetimeCreditsSurvivePendingChange` are witnesses.
`creditPoolConserved` requires the plan and lifetime folds to hold independently.

**What happens.** A `creditsExpire: "never"` plan has 100 credits. A scheduled change to a plan that
grants 5 lands at the boundary. The close replaces the pool with the new grant and records no
expiry:

```text
2 start credits 100 expire never
2 close PlanChanged,PeriodClosed,UsageReset
2 after close credits 5
```

The same close also has no way to say that the 100 plan credits expired, because the plan and the
lifetime part share one field. A one-off pack survives only because `prepaidCredits` carries a
second number.

**Decision:** [0037](../../docs/adr/0037-a-lifetime-grant-is-a-balance-source.md) makes a lifetime
grant a `one_off` balance source and a plan's credits a `plan` source. The close expires/replaces
the plan source and leaves the lifetime source alone. A consumable subscription plan item may not
state `resets: "never"`; a non-consumable seat is the exception. A lifetime credit grant is a
one-off item or a standalone balance.

**Proposed fix:** introduce balance sources, migrate `credits`/`prepaidCredits`, and record
`CreditsExpired` for every plan source the boundary replaces.

## F8 — `ResetAllowance` mutates a terminal standing

**Where:** `ResetAllowance` decide. It checks `Subscribed`, the allowance, the recorded boundary and
the clock. It does not check `allowsUsage`/`rollsPeriod`/`isTerminalStatus`.

**Model:** `windows.qnt` `resetWindow` requires `state.phase == Open`;
`noWindowResetAfterEnd` requires every window's last reset to be at or before the end.

**What happens.** An expired standing with a daily allowance still has `resetAt`. The scheduled
`ResetAllowance` fires, releases the feature's open holds, zeroes `usage`/`billed`, rewrites
`remaining`, and schedules the next boundary:

```text
7 status expired resetAt { messages: 2030-01-02T00:00:00Z }
7 reset on terminal PlanItemReset
7 after reset status expired remaining 10 resetAt { messages: 2030-01-03T00:00:00Z }
```

**Why it matters:** ADR 0020 says a terminal standing is replaced, not moved; `ClosePeriod` and
`TrackUsage` refuse it, but a per-feature window can still rewrite its counters and drop holds. The
read model then shows a reset that no open period owns.

**Proposed fix:** refuse (or ignore) `ResetAllowance` for a terminal standing, exactly as
`ClosePeriod` does. A terminal standing's windows have no next boundary.

**Fixed.** `ResetAllowance` records nothing for a terminal standing; `test/standing/Findings.test.ts`
pins the daily-boundary-after-expiry probe.

---

## F9 — a seat reduction's credit is recorded and never applied

**Where:** `quantityProrations` is written by `QuantityChanged`, read by
`RecordQuantityProrationInvoice`, and was never consumed. `closePeriodEvents` had no
quantity-proration branch.

**Model:** `money.qnt` records a negative `due` and refuses to invoice it; the fix adds
`applyQuantityCredit`, which spends it against a later charge, capped by that charge.

**What happened.** A reduction recorded `{ due: -50 }` on the standing. No command applied it
against the next period, the next tier change, or a refund. The comment on `quantityProrations`
said "a credit stays here for the next period to apply", but nothing in the close or the charge
path read it. The ADR used the same sentence.

**Why it matters:** the customer was promised a credit that the implementation never spent. It is a
gap rather than a wrong transition, but it is money.

**Fixed.** [ADR 0042](../../docs/adr/0042-a-quantity-credit-settles-the-next-charge.md) makes the
credit a fact with a consumer: `ApplyQuantityCredit` spends the unapplied part of a negative `due`
against the next positive, uninvoiced quantity charge in the same currency, oldest credit first. The
amount is the smaller of the credit and the charge, so a credit larger than the charge leaves a
remainder for a later one and is never paid out as cash. `QuantityCreditApplied` records the target,
the credits consumed and the net `due`; the target's `Proration` becomes `charge - credit` and the
source entries record `creditApplied`. `ChargeQuantityProration` applies the credit before it opens
the invoice and bills the net; a fully covered charge records the application and opens no invoice.
A replay applies once: the source's `creditApplied` is monotonic and the target's due is already
reduced. A period close neither spends nor drops the credit — it has no quantity charge to settle,
so the credit survives and the next period's first change spends it. The F9 probe, a credit larger
than the next charge, and a close with an unapplied credit are pinned in
`test/billing/QuantityCredit.test.ts`; the collector path is in `test/billing/QuantityCharge.test.ts`;
and `money.qnt`'s `quantityCreditAppliesTest`, `quantityCreditLargerThanTheChargeTest` and
`quantityCreditAppliesOnceTest` are the named scenarios.

---

## F10 — a pending tier survives terminal expiry

**Where:** `GraceElapsed`/`Expire` evolve only change `status`; `pendingTier` and `resetAt` are left.

**Model:** `standing.qnt` does not assert a terminal standing has no pending tier; `ScheduleTierChange`
refuses a terminal one. The audit's point is that a pending schedule created while open is not
cleared by the terminal transition.

**What happens.** Schedule a change on an active standing, enter grace, expire. The standing is
`expired` with `pendingTier: small`:

```text
expired status expired pendingTier small cancelAtPeriodEnd false
```

No close will ever read it, and `WithdrawTierChange` is the only way to clear it. `standingConditionsOf`
will report a pending tier on a terminal account.

**Why it matters:** it is stale commitment on a state no command can move. Not money by itself, but
a console and a future `Resume`/replacement have to know it is meaningless.

**Proposed fix:** clear `pendingTier` on `SubscriptionExpired` (and on the close that cancels), or
make `standingConditionsOf` hide it for terminal phases. Clearing is the smaller state.

**Fixed.** `SubscriptionExpired` and a close into a terminal status clear the schedule (and with it
`pendingTier`); the billing view does the same. `test/standing/Findings.test.ts` and
`standing_test.qnt`'s `expiryClearsPendingTest` pin it.

---

## F11 — grace accepts a deadline at or before `now`

**Where:** `EnterGrace` (`command.graceUntil` is stored as-is), `RecordPaymentFailure` (`graceUntil`
is stored or maxed).

**Model:** `standing.qnt` `enterGrace` and `failPayment` require `graceUntil > state.now`.

**What happens.** An operator command or a late webhook can set `graceUntil` in the past. The
standing enters `grace` with a deadline already behind it; `GraceElapsed` is scheduled at that past
instant, and whether it fires immediately is the platform's scheduling question, not a model rule.
`StartTrial` and `ExtendTrial` refuse a past/non-forward deadline; grace is the one window that does
not.

**Why it matters:** a lapsed grace is a state `standingPhaseOf` reports as `overdue` the instant it
opens. If the scheduler does not replay, the account stays in grace forever; if it does, it expires
immediately. Both are avoidable.

**Proposed fix:** refuse `graceUntil <= now` with a typed rejection (or clamp it forward) in
`EnterGrace` and `RecordPaymentFailure`. A webhook with a stale deadline should be a no-op, not a
lapsed window.

**Fixed.** `EnterGrace` refuses with `GraceDeadlineNotLater`; `RecordPaymentFailure` records nothing
when the effective deadline is at or before now, and keeps an existing live deadline otherwise.
`test/standing/Findings.test.ts` pins both.

---

## F12 — a cancellation and a pending tier both apply at the same close

**Where:** `closePeriodEvents` emits `PlanChanged` first, then `PeriodClosed` with
`statusAfter: state.cancelAtPeriodEnd ? "canceled" : …`.

**Model:** `standing.qnt` has both actions and its close applies both.

**What happens.** A standing with `cancelAtPeriodEnd` and a `pendingTier` closes into `canceled` on
the *new* tier, after recording a `PlanChanged` and the new pool. No money is collected for the new
period (there is no next period), but the terminal standing's tier and pool are the scheduled
change's, not the ones it was on when it canceled.

**Why it matters:** it is an unspecified precedence, not a crash. A console says "canceled on pro"
for an account that was on free when it canceled.

**Proposed fix:** decide the precedence. The likely rule is that a cancellation wins the boundary and
the pending change is withdrawn (no `PlanChanged`), or the change is applied and the cancellation is
the next boundary's. Pin it in the model and a story.

**Fixed.** A cancellation wins the boundary (ADR 0039 §5 and §7): no phase lands, the tier stays the
one the account was on, and the pending schedule is dropped. `standing.qnt`'s
`applyClosePeriod`, `cancellationWinsTheBoundaryTest` and `test/standing/Findings.test.ts` pin it.

---

## Notes, not findings

- **The hold release at a close.** `closePeriodEvents` emits a `UsageReleased` per open hold of a
  reset feature, then `UsageReset` removes the entities. `paykit.qnt` models the same state change
  by marking the hold `Available` without a release event. The state agrees; the timeline is richer
  than the model. Not a bug, but a reader of the model should know the release facts exist.
- **A refund keyed by command id, not by provider id.** `Refund` stores under `commandId`;
  `ReverseRefund` finds by `refundId` with `refundOfProviderId` (first match). Two different
  commands with the same provider refund id would create two records and a reversal would hit the
  first. Provider ids are unique, so this is a note rather than a reachable state.
- **A goodwill grant on a terminal standing.** `GrantCredits` is allowed by ADR 0020, but a later
  `Subscribe` carries only `prepaidCredits`, so the granted credits do not survive the replacement.
  The docs say "goodwill"; if it is meant to survive, it needs the prepaid treatment.
- **A new tier change replaces a credit proration.** `PlanChanged` clears the old `proration` and
  `prorationInvoice`; a negative `due` (a credit the account was owed) is dropped rather than
  applied. The code says "a new tier change replaces what the old one owed"; a credit is not an
  "owed" in the same direction. Decide whether it should carry.
- **The webhook table.** `WEBHOOK_TRANSITIONS` says `payment_succeeded` on `Canceled` is
  `ignored`, while `Subscribe` would reactivate a canceled standing. This may be deliberate (a late
  payment after a cancellation is not a new subscription), but the table is the only place the
  asymmetry is stated.
- **Currency.** `money.qnt` is single-currency; the per-currency ceiling is covered by
  `Refund.test.ts`. The identity findings do not depend on the dimension.

## Verification

```sh
pnpm spec          # 9 models, every invariant, every witness
pnpm spec:test     # 9 scenario modules (paykit, standing, windows, money, …)
pnpm spec:mutants  # 76 mutants, all killed
pnpm spec:coverage # 44 commands, 41 modelled, 3 out with a reason
```

The probe scripts used for the evidence are not committed: they construct states with
`decideAt`/`evolveAt` from `packages/paykit/test/properties/Arbitraries.ts`. Each fixed finding now
has a test in that shape: `test/billing/InvoiceIdentity.test.ts`, `test/billing/QuantityCredit.test.ts`,
`test/standing/Findings.test.ts`, `test/properties/Quantities.test.ts`, and the named
`standing_test.qnt` and `money_test.qnt` scenarios.
