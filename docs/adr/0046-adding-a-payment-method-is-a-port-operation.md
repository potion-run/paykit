# 0046 — Adding a payment method is a port operation

- **Status:** Accepted
- **Date:** 2026-11-09
- **Follows:** [0018](./0018-a-saved-method-is-a-capability.md), [0003](./0003-the-deploy-provisions-the-vendor.md)

## Context

Billing has a way to sell a plan and a way to open the portal, but no way to add a payment method
without a purchase. That is a real case, not a convenience: a free plan may want a card on file
before a later upgrade, a trial may ask for a method up front, and a dunning recovery may need to
replace an expired card before a retry can succeed. Today `Payments` has `createCheckout`,
`createInvoice`, `charge`, `refund`, `createPortal`, `setQuantity` and `reportUsage`, and none of
them does that.

The provider owns the card page. Stripe exposes it as a Checkout Session in `setup` mode; Polar, a
merchant of record, exposes it as the customer session its portal already uses. What the library
owes is one port operation and one binding, shaped like `Portal`: ask the provider the account
already pays through, hand the deployment a URL, and record nothing.

## Decision

**1. `setupPayment` is a `Payments` port operation, and `"setup"` is a capability.** The external
system gains:

```ts
setupPayment: {
  args: { account: string, commandId?: string },
  success: { url: string },
  error: [ProviderCapabilityMissing, PaymentDeclined],
}
```

It returns a hosted URL where the customer adds a method; the deployment redirects there. It never
charges, never opens a period and never writes a paykit command. The provider's
`payment_method.attached` (or the deployment's own follow-up) is not a standing change. The URL is
the whole answer, exactly like `createPortal`.

**2. The port fits the manual provider.** `Manual` has no card rail and declares no `setup`;
calling it is `ProviderCapabilityMissing({ op: "setupPayment" })`, never a fake URL. `Memory`
declares `setup` and returns a stable fake URL, so examples and tests can exercise the operation
without a vendor.

**3. Stripe is a Checkout Session in `setup` mode.** The distilled client gains an optional
`createSetupSession` returning `{ url }`, and `PaymentsStripe` declares `setup` only when the
binding is supplied, exactly as it does for `charge`, `invoice` and `refund`. The session carries
the customer and `client_reference_id` with the same convention as `createCheckoutSession`, and the
command id is Stripe's idempotency key.

**4. Polar uses its customer session.** A merchant of record owns the portal where a method is
managed, so `PolarClient` implements `createSetupSession` with the same customer-session call as
`createCustomerSession`. Polar has no idempotency key for a customer session, so the port's command
id is accepted and not sent. `PaymentsPolar` declares `setup` only when its binding can open the
session.

**5. One operation binding, like `Portal`.** `Paykit.SetupPayment(account)` resolves the provider
the account already pays through, provides only that provider's layer, and answers the URL. It is
an in-process operation: the Api does not serve it, because a browser has no provider, and it is
not an `Atom` command for the same reason. The verb's refusal union is `ProviderCapabilityMissing`,
`PaymentDeclined`, `Unauthenticated` and `Forbidden`.

**6. Conformance is the spec.** A provider that declares `setup` returns a non-empty URL and one
that does not fails with `ProviderCapabilityMissing`; the command id reaches the fake binding; the
operation routes an account with a Stripe ref to Stripe and refuses a manual account. Stripe and
Polar each test the client call that opens the page.

## Consequences

- **A deployment can add a method without inventing a purchase.** A free plan, a card-required
  trial and a dunning recovery all use the same verb, and the provider's own page handles the card
  and any authentication it needs.
- **Nothing enters the log.** The operation returns a URL and records no event, so replay, the
  standing and every read model are unchanged. A deployment that needs to remember a follow-up
  writes its own fact after the provider confirms it.
- **A provider without `setup` is visible.** The console can hide the action and a caller can
  match `ProviderCapabilityMissing`; a fake URL is never returned.
- **The URL is not the confirmation.** A redirect back to the deployment says the customer left
  the page, not that a method attached. A deployment that must know reads the provider or handles
  its webhook; paykit does not guess.

## Alternatives considered

- **Reuse `createCheckout` with a zero-price plan.** It would open a period the account did not
  buy, write an activation the catalog did not authorize, and still need a vendor mode Stripe
  chooses for it. A setup page is not a purchase.
- **Reuse `createPortal`.** A portal lets a known customer manage methods, but a provider without
  a portal can still host a setup page, and the two operations have different vendor modes. One
  verb would hide which one a deployment got.
- **Make `setup` required and fake it on `Manual`.** A manual provider has no card to add, and a
  fake URL would turn a missing capability into a broken page.
- **Return a stored-method id instead of a URL.** It would make the library own the vendor's
  method object and force every provider into one method vocabulary before any of them agreed on
  it. The URL is the smallest common answer.

## What would reopen this

- **A setup intent that must be completed in the browser**, with an id the deployment uses to
  confirm the method: the operation would return a client secret or an intent id, not only a URL.
- **A provider-neutral stored-method id**, so a dunning policy can name the card it charges: the
  port gains a method read and the model gains a place to keep it.
- **A setup that also writes a paykit command**, such as a card-required trial whose standing only
  starts after the method attaches: that is a standing change with its own command, event and
  refusals, not an extension of this operation.
