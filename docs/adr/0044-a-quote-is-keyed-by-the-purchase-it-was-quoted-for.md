# 0044 — A quote is keyed by the purchase it was quoted for

- **Status:** Accepted
- **Date:** 2026-11-13
- **Follows:** [0041](./0041-a-custom-plan-is-a-catalog-opt-in.md), [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md)
- **Amends:** [0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) §1, "what would reopen"

## Context

[ADR 0042](./0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md) §1 made a hosted purchase
carry its quote as a `PendingActivation`, stored beside the account's provider references. The record
was one per account: "A newer checkout overwrites the quote. The latest purchase is the one a
completion can be about." The ADR called that a follow-up, not a law: a quote that must survive
several concurrent checkouts would need a record keyed by the provider reference, and a reference on
the webhook event.

The limit is real. An account can open two checkouts — a second browser tab, a retry with a different
plan, a sales conversation that reopens the same deal — before either completes. With one quote the
first completion either activates the newer terms or is `PendingActivationStale`, even though its own
purchase is a perfectly good quote that was stored and then overwritten. The edge has no way to tell
"the latest purchase" from "the purchase this event names", because the event names a vendor object
and the state does not remember which object each quote belonged to.

## Decision

**1. The quote record is a map keyed by the provider reference.**
`UnsubscribedState` and `SubscribedState` replace `pendingActivation?: PendingActivation` with
`pendingActivations?: Schema.Record(Schema.String, PendingActivation)`. The key is the vendor's own id
for the purchase — a Stripe checkout session id or invoice id, a Polar checkout id or order id — never
a URL. `PendingQuote` is the new struct that carries the pair:
`{ reference: string, terms: PendingActivation }` ([`PendingActivation.ts`](../../packages/paykit/src/Subscription/PendingActivation.ts)).

**2. `AttachProviderRef` carries the reference with the terms.** The command and
`ProviderRefAttached` take `pending?: PendingQuote` in place of the bare `PendingActivation`. `evolve`
merges it into the map under `reference`: a same-reference write overwrites, a different reference
adds. The event stays additive: a pre-existing `ProviderRefAttached` with no `pending` still means
"no quote", and the standing's earlier quotes are untouched.

**3. The purchase result carries the vendor reference.** `Payments.createCheckout` success gains
`reference?: string`, the vendor's checkout session id; a provider that cannot name one omits it.
`createInvoice` already returns the invoice id, which is the reference. `Subscribe` stores
`refs: { checkout: reference }` — the vendor reference, replacing today's URL — and
`pending: { reference, terms }`. `PaymentsMemory` returns its checkout id, `PaymentsStripe` and
`PaymentsPolar` pass the vendor id through, and `distilledStripeClient` / `distilledPolarClient` read
it from `checkout.sessions.create` / `checkoutsCreate`. A provider that cannot name one keeps the URL,
which is the best identity it has; such a provider cannot sell a quoted custom plan through a
completion, which is honest rather than a silent catalog fallback.

**4. The webhook names the reference it completed.** `WebhookEvent` gains `reference?: string`, and
each decoder sets it:

| Event | Reference |
| --- | --- |
| Stripe `checkout.session.completed` | `session.id` |
| Stripe `invoice.paid` / `invoice.payment_failed` | `invoice.id` |
| Stripe `customer.subscription.deleted` | `subscription.id` |
| Polar `checkout.updated` (succeeded) | `checkout.id` |
| Polar `order.paid` | `order.id` |
| Polar `subscription.*` | `subscription.id` |

The edge matches in this order:

- reference present and in the map → that quote;
- reference present and absent from a non-empty map → no quote (a custom plan is
  `PendingActivationMissing`; a fixed plan falls back to the catalog as today);
- reference absent and exactly one quote → that quote, so an adapter that predates the field still
  works;
- reference absent and **more than one** quote → the new `PendingActivationAmbiguous({ account,
  references })`, a `409` in `HttpStatus`, added to the `Webhook` binding's refusal union and to
  `PendingActivationRefusal`.

**5. A tier mismatch on the matched quote is still `PendingActivationStale`.** The tags and HTTP
statuses do not change; only which quote the edge reads does. A reference that matches a quote for
another plan is stale for the same reason it always was: activating it would contract for terms
nobody bought.

**6. An activation clears every quote for the account.** One account has one standing; once a purchase
produces it, the other concurrent checkouts are moot. `standingFrom` builds the activated standing
without `pendingActivations`, and it is the only path either a `Subscribe` activation or a webhook
completion takes. A quote that is never completed is harmless history.

**7. No model change.** The webhook edge is deliberately not modelled
([`specs/paykit/README.md`](../../specs/paykit/README.md)); it is provider plumbing whose total table
`WEBHOOK_TRANSITIONS` is a test, not a Quint module. No command and no `decide` rule changes — the
quote is state the command path already carries, and matching it is a read before the same
`Subscribe` command. No action, invariant, mutant or command-coverage row is added.

## Consequences

- `PendingQuote`, `PendingActivations` and `PendingActivationAmbiguous` are new exports;
  `pendingActivation` is gone from both state tags, replaced by `pendingActivations`.
- `AttachProviderRef` and `ProviderRefAttached` take `pending?: PendingQuote`. The event's
  no-`pending` case is unchanged and remains the way an adapter attaches a customer id.
- `Payments.createCheckout` success and `PaymentsService.createCheckout` gain `reference?`. The vendor
  packages' `StripeBindings` / `PolarBindings`, `StripeClient` / `PolarClient`, and their distilled
  clients carry it through. The in-memory and manual providers need no new capability.
- `WebhookEvent.reference` is optional, so every existing decoder and fake still compiles; an adapter
  that never sets it works only while the account holds one quote, which is the compatibility rule.
- `Subscribe` stores the vendor reference in `refs.checkout` rather than the hosted URL, so the
  reference a completion names is also the reference the account recorded.
- `test/billing/CustomPlans.test.ts` proves two concurrent checkouts with different references: the
  older completion activates the older quote, then the map is empty; an unknown reference for a
  custom plan is `PendingActivationMissing`; two quotes and no reference is
  `PendingActivationAmbiguous`; one quote and no reference still activates.
  `packages/paykit-stripe/test/Webhooks.test.ts` and
  `packages/paykit-polar/test/Webhooks.test.ts` prove each decoded event carries its reference,
  including an invoice-paid event used for a negotiated-price activation.
- `docs/briefs/custom-plans.md`, `NEXT.md` and `BILLING-SURFACE.md` move the concurrent-quote gap to
  landed.

## Alternatives considered

- **Keep one quote and refuse the second checkout.** Rejected: the second checkout may be the one the
  customer wants, and the first may never complete. Refusing a purchase because another one is open
  is a new refusal for a case the provider already models as two purchases.
- **A queue of quotes in arrival order.** Rejected: it still has to answer "which one is this event
  about", and arrival order is exactly the wrong answer when a completion names the older purchase.
- **Match on the tier instead of the reference.** Rejected: two checkouts for one plan at different
  negotiated prices are the case the gap is about, and the tier is identical in both.
- **Put every allowance in the vendor's metadata.** Rejected in ADR 0042 and still rejected: the
  terms belong in paykit's state, where the model reads them, not in a vendor payload whose size a
  provider limits.
- **A quote as a separate stream aggregate.** Rejected in ADR 0042: it belongs to the account and
  must be read in the same state that decides the activation.
- **Clear only the quote the completion used.** Rejected: one account has one standing, so the other
  purchases cannot activate anything. Keeping their quotes would leave state that describes a
  purchase the account can no longer honour.

## What would reopen this

- **A quote that must expire.** Today an abandoned checkout leaves its quote until an activation
  clears the map or a later deploy drops it. An expiry needs a scheduled command and a clock, and the
  edge would answer `PendingActivationMissing` for a quote it used to find.
- **A vendor that cannot name the purchase.** A provider with no stable checkout or invoice id can
  store a quote but could never match a completion to it. That provider would need a different
  identity, or the capability list would have to say it cannot sell a quoted custom plan.
- **Several purchases per reference.** A vendor that reuses one reference for a subscription and its
  invoices would need the key to be a pair, or the event to name the kind as well.
- **A quote that outlives the account's standing.** Today activation clears every quote. A purchase
  that is meant to activate a later period would need its own scheduled command rather than a state
  field the activation drops.
