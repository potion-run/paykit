# Refund: which event, which money, which provider call

- **Status:** Landed; the open decisions are named at the end
- **Follows:** [0019](../adr/0019-a-refund-names-the-charge-it-reverses.md),
  [0018](../adr/0018-a-saved-method-is-a-capability.md),
  [0003](../adr/0003-the-deploy-provisions-the-vendor.md)
- **Touches:** `packages/paykit/src/{Payments,PaymentsMemory,PaymentsManual,PaymentsPolar,PaymentsStripe}.ts`,
  `packages/paykit/src/Subscription/{Refund.command,Subscription.state,Subscription.aggregate,BillingState.view,Entitlements.view}.ts`,
  `packages/paykit/src/{Timeline,index}.ts`, `packages/paykit/src/Billing/{Admin.binding,BillingAdminInProcess.layer}.ts`,
  `packages/paykit-stripe/src/{Stripe,StripeClient}.ts`, `packages/paykit-polar/src/{Polar,PolarClient}.ts`

## The decision, in one page

Money in is already an event in paykit: `PaymentRecorded`, `CreditsPurchased.price` with its reference,
`ProrationInvoiced`. Money out was not, which is why the console could not offer a refund. Three
questions had to be answered before code:

- **Which event?** `RefundRecorded` — its own fact, not a negative payment. `chargeId` (what was
  refunded, as the provider names it), `refundId` (what the provider returned), `amount`, `currency`,
  an optional `reason`, `refundedAfter` (the currency's running total), and `commandId` (the operator
  action that recorded it, which is what makes a retry a replay).
- **Which money?** The ceiling is what paykit recorded as charged, per currency: `charged` folds
  `PaymentRecorded`, `CreditsPurchased.price` and `ProrationInvoiced`; `refunded` folds
  `RefundRecorded`. `RefundExceedsCharged` is the refusal. It is not per charge, because the checkout
  path records a price and no vendor reference, so a per-charge cap would refuse the commonest refund.
- **Which provider call?** `Payments.refund({ chargeId, amount, commandId }) → { refundId }`, called by
  the `Refund` binding before the command, keyed by the operator's `dedupeKey`.

A refund never touches the credit pool. Revoking credits is `ConsumeCredits`, which an operator
session may already send, so "money left" and "credits were burned" stay two facts.

## Landed

### 1. The model

```ts
new Refund({ chargeId, refundId, amount, currency, reason?, })
```

`Admin` middleware. `decide` records nothing for a non-positive amount (the convention every money
command follows) and answers `RefundExceedsCharged` when the amount is past the ceiling. The state
carries `charged`, `refunded` and `refunds` (keyed by command id) on both `SubscribedState` and
`UnsubscribedState`, because a pack can be bought and refunded before a plan exists.

### 2. The port

`Payments.refund` stops answering `{}` and answers `{ refundId }`, and takes an optional `commandId`.
Every provider returns one: Stripe's `CreateRefund` (with its id as the vendor idempotency key),
Polar's `refundsCreate`, the memory fake, and the manual provider (a transfer back, deduped by key).

### 3. The binding

`Paykit.Refund(account)` returns a verb taking `{ chargeId, amount, currency, reason?, dedupeKey }` and
answering `{ refundId, refunded, currency }`. Before it takes money it asks two questions:

- Did this `dedupeKey` already record a refund? Answer that one — a retry must not be measured against
  a ceiling the first attempt spent.
- Does the amount fit the ceiling? `RefundExceedsCharged` if not, and the provider is never asked.

It is implemented in `BillingAdminInProcess`, where the provider is reachable, and deliberately not in
`BillingAdminApiLayer`: a console backend that owns only the Api cannot take money out, the same rule
that keeps `ChargeProration` off the Api.

### 4. The read models

`BillingState` carries `charged` and `refunded` per currency, so a page can say "charged 4,900, refunded
0". The timeline renders a `refund` entry with its amount, currency, provider id and reason. A unit
that is neither — the pool, the counters — is untouched, and a test pins that.

## Tests

| Where | What it pins |
| --- | --- |
| `test/stories/Refund.story.test.ts` | a refund records the money and leaves the pool alone; the ceiling refuses 901 of 900 left; a currency nothing was charged in refunds nothing; a non-positive refund records nothing |
| `test/properties/Refund.test.ts` | over a generated history of charges and refunds, a refund records exactly when it fits, `refunded <= charged` after every step, and the boundary (`RefundRest`) is exercised |
| `test/bindings/AdminBindings.test.ts` | the binding refuses before the provider, is idempotent per dedupe key at the provider and in the log, and is absent from the Api layer |
| `test/timeline/Timeline.test.ts` | money going back is its own entry, not a negative payment |
| `test/conformance/Payments.test.ts` | every provider answers a refund id or refuses by capability |

## Worth deciding next

- **A console screen.** The command and the binding exist; what is missing is an RPC an operator can
  reach. `AdminConsoleRpcs` carries reads and a tier change, and a refund needs the same shape: an
  operator-authenticated op that runs the in-process binding on the Worker that owns the provider. That
  is a transport decision (which group, which input, what a stale quote means), not a model one.
- **`RefundFailed`.** The vendor remains the authority on a refund's state. A refund the provider later
  fails is a webhook paykit does not model, and the page shows money that came back. An event plus a
  webhook kind is the next slice if a deployment needs it.
- **A refund that revokes credits.** A `credits` field on the command, with the pool's `prepaidCredits`
  accounting and a `RefundExceedsCredits` refusal. Deliberately two calls today.
- **A per-charge ceiling.** Once something records the vendor's reference on the checkout path (a
  `WebhookEvent.reference`), a refund could be capped by the charge it names instead of the account's
  total.

## Invariants this must not break

- `decide` stays pure: the refund id arrives on the command; nothing reads a provider inside `decide`.
- The log stays append-only: a refund is a new event, never a rewritten `PaymentRecorded`.
- Money never disappears: `charged - refunded >= 0` per currency, enforced by `decide` and re-checked
  by the binding before the provider is asked.
- A retry is a replay: the operator's `dedupeKey` is the provider's idempotency key and the command id.
