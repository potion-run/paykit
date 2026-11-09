# 0038 — Customer controls are state

- **Status:** Accepted
- **Date:** 2026-11-10
- **Follows:** [0026](./0026-a-tier-states-its-whole-top-up-line.md), [0031](./0031-a-failed-top-up-retries-on-a-budget.md), [0034](./0034-one-quint-model-per-protocol.md), [0035](./0035-plans-plan-items-and-balance-sources.md)

## Context

`Customer.billingControls` is declared and exported and nothing writes it. The shape it declares —
two arrays of read records (an auto top-up with `enabled`, `threshold` and `quantity`; a spend limit
with `enabled`, `overageLimit` and `skipOverageBilling`) — does not match anything the runtime can
enforce, so it is a read model of a feature that does not exist.

What a customer can change today is nothing:

- **The top-up line is the plan's.** `TopUpTerms` is carried on the standing from the tier
  ([ADR 0026](./0026-a-tier-states-its-whole-top-up-line.md)), and `topUpOf` reads it. A customer on
  a plan whose line is too high, or who wants refills at a different level, has no write.
- **The money ceiling is the plan's.** `moneyCap` is a plan item's field, judged by `capacityOf` in
  the write transaction. A customer who wants a lower ceiling than the plan permits cannot express
  it.
- **Usage alerts do not exist.** A deployment learns that an account crossed a threshold by watching
  the event stream, which is the same as not learning it.

[ADR 0035](./0035-plans-plan-items-and-balance-sources.md) §6 committed the answer: "customer-level
controls are state … set on the customer or entity, with plan values as defaults. They are not
catalog-only: a customer can be granted a different line without a deploy." This is that slice, and
the next model (`controls.qnt`) named in the queue.

## Decision

**1. Controls are state on the customer, written by one command.** `SetBillingControls` targets the
account, carries the whole object, and records `BillingControlsSet`. The object lives on the account
state under both tags — a control can be set before a plan exists — and it survives a plan change, a
period close and a re-activation. It is customer intent, not a plan term, so no catalog field is
added, no deploy is needed to change it, and a plan change never rewrites or prunes it.

**2. It is three controls and nothing else.**

```ts
BillingControls = {
  autoTopUp?: { enabled: boolean; threshold?: Int };
  spendLimits?: Array<{ featureId: string; amount: Int }>;   // minor units
  usageAlerts?: Array<{ featureId: string; at: Int }>;       // usage units
}
```

- **`autoTopUp` owns only the line.** `enabled: false` switches the line off; `threshold` replaces the
  tier's threshold. `pack`, `cooldown` and `retry` stay plan facts, because they are what the
  deployment sells and how often it lets itself charge a card — not something a customer may edit. A
  control that states a threshold on a plan with no line brings a line into existence, and it buys
  the deployment's default pack with the deployment's cooldown; there is no per-customer product.
- **`spendLimits` is money.** One ceiling per feature, minor units, in the standing's currency. The
  catalog already refuses a tier whose postpaid prices disagree with its price currency, and a plan
  change that would move the currency is `CurrencyMismatch`, so one account bills in one currency and
  a limit needs no currency field.
- **`usageAlerts` is evidence.** One threshold per entry, in the feature's period usage count. There
  may be several for one feature at different thresholds.

**3. A limit is a ceiling in money, not a standing.** It is judged in the same transaction as the
usage it would refuse, in `capacityOf`, beside `moneyCap`. `SpendLimitExceeded` carries the same
evidence `MoneyCapExceeded` does — the feature, the ceiling, what is billed, what open holds promise,
what this event would add — and the account's `standing` stays `good`. The binding ceiling names the
refusal: a limit below the plan's cap refuses with `SpendLimitExceeded`, the plan's cap below a limit
refuses with `MoneyCapExceeded`, and a tie names the plan's. It is enforced by `TrackUsage` and
`Hold`, and not by `SettleHold`: a hold's admission already counted itself and every other open hold,
so a settle only moves promised money into billed money and can never be the event that breaks the
ceiling. A limit set below the period's bill is accepted and binds forward — the money is already
billed, and the ceiling stops the next spend until the period resets. That is the one place this
differs from [ADR 0011](./0011-a-tier-change-cannot-move-into-a-ceiling-already-passed.md), and the
difference is the subject: a plan term is what the customer bought, a limit is an instruction the
customer may give at any time.

**4. An alert is evidence, and it never refuses anything.** `UsageAlertFired` is appended beside the
`UsageRecorded` that `TrackUsage` or `SettleHold` already records; it carries the feature, the
threshold, the period usage that fired it and the time. It moves no counter, blocks nothing, and a
spend past the limit that is refused records no alert. Identity is `(feature, threshold)`: an alert
fires at most once per standing period, an alert lowered to a value that already fired does not fire
again this period, and a threshold raised to a new value is a new alert. `SetBillingControls` fires
nothing — an alert is evidence about a usage event, and firing on a set would need the setter's clock
and produce an alert with no usage. A hold is not usage, and a direct credit consume has no feature,
so neither fires one. The fired set resets at the period close and at an activation, and not at an
allowance's own reset window.

**5. Controls are validated against the deployment, not against the plan.** `ControlsFeatureUnknown`
is a feature the catalog does not declare; `ControlsFeatureNotPriced` is a limit on a feature no plan
bills postpaid. Both are decided in `decide` from catalog facts carried on the command and checked
by `CatalogGuard`, exactly as `Subscribe` and `ChangeTier` carry allowances. A control that names a
feature the customer's current plan does not grant is stored and inert, and starts binding on the
next plan that grants it. Anything else would make a downgrade poison every later controls write: the
whole object is replaced on each write, so a stale entry the plan no longer grants would refuse a
write that only meant to change the top-up line.

**6. A duplicate entry is a refusal, not a schema failure.** `ControlsDuplicate` names the list, the
feature and the shared threshold. A payload is representable and ambiguous at once — two limits for
one feature have no answer to "which is the ceiling" — so it is a decision, like
`CatalogDuplicateFeature`, with evidence and a story, not a decode error outside the tagged union.
The other bad shapes are schema failures: a negative amount, a negative threshold, a missing
`enabled`.

**7. The write is idempotent and canonical.** `decide` normalizes the object — sorted limits and
alerts, empty arrays and an empty object collapsed — before it compares, so the same guardrail
written twice records one event and two callers that listed features in a different order record the
same one. This is `SetUsage`'s rule and `topUpKey`'s shape.

**8. The read model carries the controls and what fired.** `Balance` gains the feature's spend-limit
headroom, `BillingState` gains the object and this period's fired alerts, and `Customer` is served by
`Paykit.Customers(account)` with `get()` and `update({ billingControls })`. There is no `getOrCreate`:
a plan activation, or a controls write, is what makes a customer exist.

**9. Controls are tenant-written.** `SetBillingControls` declares `Session` like every tenant write.
An operator verb is not in this slice; support changing a customer's guardrail is a different blast
radius and its own decision.

## Consequences

- **`BillingControls` changes shape in `Customer.ts`, and nothing needs a migration.** The package is
  `0.1.0`, unpublished and never deployed; nothing has ever written the field, no consumer generation
  has to be bumped, and the catalog does not move.
- **`SubscriptionState` gains the object on both tags.** `standingFrom` builds a fresh `SubscribedState`
  and must carry it forward as it carries a lifetime grant and the currency; a plan change and a close
  spread the state, so they leave it alone by construction.
- **`topUpOf` changes meaning, and no policy changes.** It becomes the effective line — the control
  over the tier — so `AutoTopUp` and `RetryTopUp` see the customer's override without a new trigger.
  A tier that had no line can now be refilled by a control that states a threshold.
- **`check`, `allowed` and `decide` keep one rule.** The limit is a `Capacity` variant, so the read
  model, the lock and the write agree; a refused spend is a capacity answer with `standing: good`,
  which a page must present as a ceiling and not as dunning.
- **Two read models gain a field and a handler**, `Balance` gains one, and `check` gains one refusal
  reason on the paths that can place a hold.
- **The log answers "what was this customer's guardrail at time T".** The object is on the event, not
  only on the read model, so a rebuild reproduces it and a page can show the history.
- **An alert is a subscription event like any other**, so the existing outbound policy signs and
  delivers it; no second delivery path is introduced.
- **A refund, a reversal and a credit consume are untouched.** Controls are about spend, not about
  money coming back.

## Alternatives considered

- **Three commands, one per control.** Three `decide` paths, three guards, three sets of refusals, and
  no single event that says what the guardrail was. One object with one write has one answer.
- **A catalog field with a per-customer override map.** A deploy to change a customer's line, a map
  that validates against nothing, and a second place the catalog lives. ADR 0035 §6 already refused it.
- **Enforcing the limit in a policy.** A policy runs after the commit, so the usage would already be
  recorded and the refusal would arrive too late to be a refusal.
- **Refusing a limit below the period's bill.** Symmetric with [ADR
  0011](./0011-a-tier-change-cannot-move-into-a-ceiling-already-passed.md) on its face, but the
  subject is different: a downgrade moves the customer into a term it did not buy, and a limit is a
  term the customer is asking for. Accepting it and binding forward is the smaller surprise.
- **Validating against the standing's allowances.** Stable at the moment of the write and wrong one
  plan change later: the whole object is replaced on each write, so an entry for a feature the new
  plan no longer grants would refuse every later write until the caller stripped it. A control is
  customer intent; it should outlive a plan.
- **A separate alert command and a policy over usage.** A second write path for evidence that the
  usage event already determines, and a second place for "once per period" to be got wrong.
- **Putting the object only on the read model.** The limit must be judged in the same transaction as
  the usage, and `decide` cannot read a view.

## What this does not decide

- An operator or admin write for a customer's controls.
- Alerts that re-arm on an allowance's own reset window rather than the standing's period.
- A spend limit over a seat purchase (`SetQuantity`, `QuantityProration`), which is money for a
  feature but not usage billing.
- Entity-scoped controls, which belong with entities and transfer in Phase 6.
- A per-period budget for how many top-up packs may be bought; [ADR
  0026](./0026-a-tier-states-its-whole-top-up-line.md) already names it as a different number with
  its own refusal.

## What would reopen this

- A ceiling a vendor must enforce (a provider-side spend cap), which would make the limit a provider
  object rather than a `decide` rule.
- An alert that must page someone, which is a delivery guarantee rather than an event.
- A limit that must be checked before the charge exists, which is a hold and not a ceiling.
- A second currency per account, which would add a currency to every limit.
- An operator surface, or a per-entity scope, either of which changes the guard and the key.
