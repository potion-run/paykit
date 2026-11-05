# 0013 — An auto top-up is a purchase on a crossing

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0002](./0002-credits-are-the-unit-of-account.md), [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md)
- **Supersedes:** none

## Context

The catalog can sell a one-off pack of credits, and the runtime can spend them: `Track` and
`Settle` draw the account's pool down, a hold reserves it, and a period close expires only the
part a plan granted. What the library cannot do is notice that the pool is about to run out and
refill it. A customer discovers the problem as a `CreditExceeded` or a successful work call
turned into a billing incident, which is the difference between billing users notice and billing
they do not.

Three questions have to be answered before code: what counts as "below", who moves the money, and
how often one crossing may buy.

- The runtime already has the event that answers "below": every credit spend carries the pool
  before and after it (`UsageRecorded.cost` / `.creditsAfter`, `CreditsConsumed.amount` /
  `.balanceAfter`), so a policy can tell a crossing from a level without reading the aggregate or
  the clock.
- The money plane has one way to collect an amount on its own: `Payments.createInvoice`, the same
  operation a proration uses. It has no off-session card charge, and `Manual` has no card at all.
- A top-up is a purchase, not a grant: the pack is a tier the catalog already sells, and the
  provider is the invoice.

## Decision

**1. The threshold and the pack are deployment policy, not a price.** A deployment opts in with
`Paykit.autoTopUp({ catalog, threshold, pack })`, which returns a Layer. The pack is named by
tier id and resolved against the validated catalog; it must be a `kind: "one_off"` tier with
credits and a price. An unknown pack, a subscription tier, a pack with no credits or no price, or
a negative threshold fails the layer with `AutoTopUpInvalid`, because a deployment that starts
half-on is worse than one that refuses to start. The bucket the policy fills is the whole
deployment: a per-tier threshold is a later field on the tier, not a second config.

**2. A crossing, not a level.** The policy buys when a spend event takes the pool from above the
threshold to at or below it:

```
before > threshold && after <= threshold
```

`before` is `creditsAfter + cost` for `UsageRecorded` and `balanceAfter + amount` for
`CreditsConsumed`, so the policy reads only the event. A second spend while the pool is already
below the threshold is not a crossing, which is what makes the rule "one purchase per crossing
rather than one per event". Grants, expiries, hold reservations and releases never trigger it:
they are not spends, and a reservation is a promise against the pool, not a charge.

**3. One command per crossing, keyed by the crossing.** The command id is
`topup:<account>:<event seq>`, and the invoice carries the same key. A redelivered event is the
same command and the same invoice; a different crossing is a different id. The policy also skips a
crossing whose pool has already recovered, so a late redelivery cannot buy a pack the account no
longer needs. If the invoice was already opened and the policy died before recording it, the retry
finds the same invoice and lands the same pack, because the money and the credits share one key.

**4. The pack is the cooldown.** There is no time window. After a purchase the pool is above the
threshold by the pack's credits, so the next crossing costs at least the pack before it can happen.
A time cooldown would need a timer command, and it would refuse a genuine refill for a reason the
customer cannot see; the pack's size and the threshold are the two numbers a deployment uses to
bound how often it can buy. If a deployment needs a harder spend-rate bound, that is a later
decision with its own timer.

**5. The money is an invoice and the credits are recorded.** The policy asks the account's provider
for `createInvoice` for the pack's price, keyed by the crossing, then sends `PurchaseCredits` with
the invoice id. `CreditsPurchased` already carries the amount, the price and the rate cards; it
gains an optional `invoiceId`, which is what marks a purchase the deployment opened rather than one
a checkout completed. The pool grows, `prepaidCredits` grows (a pack never expires), and the log
answers "what did we charge" without reading the provider.

The policy does not charge a saved card. It opens the invoice the provider collects by its own
rules — a processor with automatic collection takes the card on file, a `Manual` deployment waits
for the transfer — and a decline stays the provider's fact, not a second paykit ledger. A chosen
provider without `invoice` is `ProviderCapabilityMissing`; the policy does not fall back to granting
credits no invoice will collect.

**6. `PurchaseCredits` stays the one purchase command.** A webhook purchase and a policy top-up
record the same fact and the same event; the difference is the invoice id the policy adds. A second
`TopUpCredits` command would have to repeat every field and every rule to record the same thing,
and the model would then have two purchase paths to keep in step.

## Slices

### 1 — the policy, the invoice and the record

Landed: `AutoTopUp` (a policy over `UsageRecorded` and `CreditsConsumed`) and
`Paykit.autoTopUp`; the crossing arithmetic; the provider invoice keyed by the crossing;
`PurchaseCredits.invoiceId` / `CreditsPurchased.invoiceId`; a story for the refill, one for "one
purchase per crossing", and one for a deployment that never opted in; a unit test for every
`AutoTopUpInvalid`.

### 2 — not in this slice

A per-tier threshold and pack (`Tier.topUp`, carried on the standing like `pendingTier`), a
time cooldown as a scheduled command, and an off-session charge capability with a saved payment
method. Each is a decision of its own; none is required for the refill to work.

## Consequences

- **The account is refilled before the money is collected.** That is the same posture postpaid
  usage already takes: the log records what is owed, and the provider is the invoice. A deployment
  that cannot extend credit must not turn this on.
- **An account with no provider customer can refuse the invoice.** The policy asks the account's
  provider, and a vendor that has never seen the customer fails the call; the policy dies and the
  platform retries, which is visible rather than a silent free pack.
- **One threshold for the whole deployment.** A free tier and an enterprise tier refill from the
  same pack. The per-tier config is the next decision, not a hidden default.
- **The console needs no new screen.** `CreditsPurchased` already moves the balance in `BillingState`
  and `Entitlements`; the invoice id on the event is what lets an operator say "this was a top-up".
- **A pack that a plan also grants still keeps its protection.** `prepaidCredits` grows by the
  pack's credits, so a period close never expires what the top-up bought.

## Alternatives considered

- **A time cooldown enforced by a scheduled `TopUpCredits`.** It buys a timer per crossing and a
  second command, and a customer who burned a pack in a minute is blocked either way. Rejected for
  this slice; the pack's size is the bound.
- **An off-session charge capability.** Stripe can do it, Polar and `Manual` cannot, and a merchant
  of record owns collection. It would turn a deployment-wide policy into a provider-specific one.
  A later ADR can add the capability without changing the crossing rule.
- **A catalog field on the tier.** It would put the threshold in stack state, in `CatalogGuard`, in
  every activation and scheduled-change payload, and force a stack version bump, for a policy that
  is not a price. Rejected until a deployment genuinely needs two buckets.
- **A separate `CreditsToppedUp` event.** Two events for one fact, two folds, two read-model cases,
  and a console that has to know both. The invoice id is the difference, not a new fact.
- **Trigger on `CreditsExpired` or a hold.** Expiry is the plan's own grant ending, and a hold is a
  promise, not a spend. Either would buy a pack for a pool that did not run out.

## What would reopen this

- A per-tier top-up, or a deployment that wants a hard spend-rate bound: a `cooldown` command and
  a `Tier.topUp` field.
- A provider that can charge a saved method: an optional `charge` capability on the port.
- A refusal from the vendor that paykit has to remember (a declined card): a `TopUpFailed` event
  and the dunning policy, instead of leaving the decline to the provider.
