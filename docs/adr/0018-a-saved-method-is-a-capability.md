# 0018 — A saved method is a capability; the invoice stays the record

- **Status:** Accepted
- **Date:** 2026-11-06
- **Follows:** [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md), [0017](./0017-a-top-up-cooldown-is-a-deadline-on-the-standing.md)

## Context

[ADR 0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) made the top-up an invoice: the policy asks
the account's provider for `createInvoice`, keyed by the crossing, and records the pack with that invoice
id. It named the reason it did not charge a saved card — "it would turn a deployment-wide policy into a
provider-specific one" — and named the way back in: "an optional `charge` capability on the port".

That sentence is the opening, and the case for taking it is narrow and real. An invoice is collected by
the provider's own rules, which for a processor means an attempt at a time paykit does not choose; for a
deployment whose customers keep a card on file, a top-up that is charged at the crossing is money the
deployment has rather than money it is owed, and it fails visibly instead of silently waiting.

Everything else about the slice is already decided: the crossing rule, the command id, the purchase
command, the pack's protection in the pool. What is left is one operation, one capability, and the
question of what happens when the charge is refused.

## Decision

**1. `charge` is an optional operation on the port, declared like the rest.** `Payments` gains
`charge({ account, amount, currency, commandId }) → { chargeId }`, and `PaymentCapability` gains
`"charge"`. A provider that can take a saved method implements it and lists the capability; a provider
that cannot returns `ProviderCapabilityMissing` and does not list it, exactly as `usage` works. The port
stays one interface with one layer per provider, so nothing about a deployment's shape changes.

**2. The policy prefers the charge and falls back to the invoice.** The crossing, the command id and the
purchase are the same; only the money path changes:

```
provider declares "charge" → charge   → invoiceId
                             declined → invoice
provider declares no charge           → invoice
```

The fallback is the decision that keeps this from becoming the provider-specific policy ADR
[0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) warned about. A declined charge is not an
account that may not be refilled — it is a card that did not work, and the invoice is right there. It
also means a customer with an outstanding balance is still refilled and still owes, which is the posture
the invoice already took: the account is refilled before the money is collected.

**3. What paid is on the event.** `CreditsPurchased` gains an optional `chargeId` beside `invoiceId`.
`invoiceId` keeps its meaning — the provider record paykit opened, whether the policy charged or
invoiced — and `chargeId` names the charge when there was one. A replay answers "how was this pack paid
for" from the log, without asking the provider. The timeline renders both.

**4. A decline is a failure the caller can match, not a defect.** `charge` fails with `PaymentDeclined`,
the same error `createInvoice` already uses, so a policy that wanted to stop rather than fall back can
match it. Nothing about this slice records a `TopUpFailed`: a decline that becomes an invoice is not a
state the standing needs, and one that matters is a later event with dunning behind it, which ADR
[0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) already names.

**5. The charge is keyed by the crossing, and it is one charge.** `commandId` is the crossing's id — the
same string the invoice would have used — and a provider that supports an idempotency key sends it, so a
redelivered spend is the charge it already took. A provider with no idempotency contract is the same case
as the invoice's: the caller still records once, and the vendor's duplicate is the vendor's to reconcile.

**6. Who declares it.** Stripe, by creating and confirming an off-session `PaymentIntent` against the
customer's default method. Polar does not: it is a merchant of record whose `ordersFinalize` already
attempts an off-session collection, so its invoice *is* the charge and a second op would be a second way
to do one thing. `Manual` has no card and declares nothing. `Memory` declares it and records what it
charged, so a test can tell the two paths apart.

## Consequences

- **A deployment on a provider without `charge` is unchanged.** Same invoice, same event, same
  `invoiceId`. The capability is additive, and the fallback means no deployment has to opt in twice.
- **A charge that succeeded and a purchase that failed is one retry away from a second charge** unless
  the provider honors `commandId`; a provider that cannot is the same risk the invoice path already
  carries, and the crossing's id is the key both paths share.
- **The account can be charged and then refunded alone.** Nothing here records a refund; `refund` is its
  own port operation and the console still has no screen for it, as [NEXT](../../docs/NEXT.md) says.
- **`invoiceId` is still required evidence for a charged pack?** No: a charged purchase carries
  `chargeId` and no `invoiceId`, and both read models already treat the presence of either as "the
  deployment opened this purchase". A checkout's purchase carries neither.

## Alternatives considered

- **Make `charge` required and drop the invoice path.** Every provider would have to implement a card
  charge, including a manual one that has no card, and the merchant-of-record case would have to model a
  capability it already expresses through its own collection.
- **Have the policy never fall back: a decline dies.** ADR
  [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) already accepted dying for a missing
  capability; dying for a declined card turns a customer's expired card into a retry loop that never
  refills them, when the invoice would have.
- **A separate `TopUpCredits` command for the charged path.** The same rejection ADR
  [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md) made: one purchase fact, one command, one
  event, and the money reference is the difference.
- **Put the charge behind a second policy.** Two policies reacting to one crossing, with the same
  dedupe key and no ordering between them, is how a pack gets bought twice.

## What would reopen this

- A decline that must be remembered: a `TopUpFailed` event and the dunning policy, instead of a fallback.
- A provider that can charge only with an explicit payment-method id: the arg is additive on the port.
- A per-tier pack or a refund command: separate decisions, as [NEXT](../../docs/NEXT.md) says.
