# 0045 — A customer is created before it buys

- **Status:** Accepted
- **Date:** 2026-11-10
- **Follows:** [0035](./0035-plans-plan-items-and-balance-sources.md), [0038](./0038-customer-controls-are-state.md), [0040](./0040-an-entity-is-a-scope-not-a-customer.md)

## Context

A customer exists only as a consequence. The account id is the customer id, a plan activation or a
`SetBillingControls` write gives it state, and `Paykit.Customers(account).get()` synthesizes a
`Customer` for any account id. [ADR 0038](./0038-customer-controls-are-state.md) §8 recorded that
shape on purpose: "There is no `getOrCreate`: a plan activation, or a controls write, is what makes a
customer exist."

Two gaps follow from it.

- **A deployment cannot record who the customer is.** Its name and its email address have nowhere to
  live until it buys something, so a billing page shows an id, and a receipt or a dunning notice has
  no address until the provider already has one. Writing controls just to create the record changes
  a guardrail the caller did not mean to touch.
- **There is no "create if absent" verb.** A sign-up flow has to activate, write controls, or accept
  that the customer does not exist yet, and none of those is the sentence the flow means.

The reference billing surface has `customers.create` and `customers.getOrCreate`. Both are ours
([`BILLING-SURFACE.md`](../BILLING-SURFACE.md) item 5), and the customer vocabulary already puts the
identity on the customer rather than on a plan.

## Decision

**1. A customer is created by its own command, not by a side effect.** `CreateCustomer` is a tenant
command on the account's aggregate (`target: AccountId`, `middleware: [Session]`), recording
`CustomerCreated`. The account is the customer, as everywhere else
([ADR 0040](./0040-an-entity-is-a-scope-not-a-customer.md) makes an entity a scope, not a second
customer); the command records the identity a billing page needs, and no billing decision reads it.

**2. The event is additive and the state is a latch.**

```ts
CustomerCreated = { name?: string; email?: string; at: DateTimeUtc }

CustomerDetails = { name?: string; email?: string; createdAt: DateTimeUtc }
```

`SubscriptionState` gains `customer?: CustomerDetails` on both tags, so an identity can be recorded
before a plan exists and survives one. `evolve` writes it on `CustomerCreated` and every other event
spreads the state it already has, so a plan change, a period close and a cancellation leave it alone.
`standingFrom` carries it into a fresh activation the way it carries `billingControls` and a lifetime
grant, because activation builds a new standing and a field it does not copy is lost.

**3. `create` is idempotent on equal details and refuses different ones.** A second `CreateCustomer`
with the same `(name, email)` records nothing — a replay that did not need the command id, so a
retried sign-up cannot write twice. A second one with different details is `CustomerExists`
(`account`, `name?`, `email?` carrying the identity in force). Renaming a customer is a separate
concern: this slice does not invent an update command, and a deployment that needs a rename gets the
ADR it deserves.

Details are compared exactly as recorded, not normalized: `"Ada"` twice is one identity, and `"Ada "` or a
different address is another. The binding refuses an empty name or address, so a caller of
`customers.create` cannot record one by accident; a caller that speaks the Api directly meets the
comparison as it is, which is still a refusal rather than a second record.

**4. `getOrCreate` is a read, then the same command.** In the `Paykit.Customers(account)` binding:
read the billing view; if `customer` is present, answer that customer without a write. If absent, run
`CreateCustomer` and answer the customer the write waited for. The two verbs then keep distinct
meanings: `create` states an identity and refuses a different one, while `getOrCreate` is the
idempotent sign-up path and never refuses an existing customer, whatever details it was passed.

**5. The command id is derived from the request.** `CreateCustomer` is a write, so it needs a stable
id: the binding accepts an optional `dedupeKey` and, absent one, derives
`create:<account>:<name ?? "">:<email ?? "">`, each part percent-encoded so a `:` or an `@` in a name
cannot spell another identity's key. A retry with the same details is the same write; a different
identity is a different command id, so `decide` sees it and refuses it instead of the store deduping
it as a replay.

**6. The read carries the identity.** `BillingStateView` gains `customer?: CustomerDetails`, folded
from `CustomerCreated`, and `Customer` gains `createdAt?: DateTimeUtc`; `customerOf` fills `name`,
`email` and `createdAt` from the view. A customer with no record keeps today's shape — name and email
absent — and `get()` still never refuses for absence. `BillingState` is the view because a billing
page already reads it; `Entitlements` emits `CustomerCreated` as a no-op so the cross-account
projection sees the whole log, and moves no count.

**7. No model change.** The identity is a latch that no spend, plan, clock or money rule reads: no
action, invariant or mutant is added, and `scripts/spec-coverage.ts` gets `CreateCustomer: null` with
its reason in the "out of every slice" group, beside the other commands with a written reason. Modelling
an identity would model nothing a decision turns on.

## Consequences

- **New public words:** `CreateCustomer` (the binding), `CustomerRequest`, `CustomerDetails`,
  `CustomerExists`, `CustomerCreated`, and `Customers.create` / `Customers.getOrCreate`. The Api
  serves `CreateCustomer`; both tenant layers implement it; `Atom` gains `createCustomer` and
  `getOrCreateCustomer` command atoms that invalidate `paykit/account/<id>`.
- **One command binding and one facade.** `CreateCustomer` owns the write, its request and its
  refusals; `Customers.create` delegates to it rather than duplicating the command, so the Api layer
  and the in-process layer cannot drift.
- **The write waits for its read.** Like `SetBillingControls`, the verb reads `BillingState` with
  `atLeast` its receipt, so a caller's next `get()` sees the identity and an `Atom` query refreshes
  on the invalidated key.
- **An empty request is legal and latches.** `create({})` records that this account is a customer with
  no details; a later create with details is `CustomerExists` until a rename command exists. It is a
  consequence of "the identity is stated once", not a second rule.
- **The log answers "who was this customer at time T".** The identity is on the event as well as the
  state, so a rebuild reproduces it and a console can show the history.
- **Nothing else moves.** A plan does not read the fields, a refund and a top-up are untouched, the
  catalog does not change, and no SQL column is added: `BillingState` is a consumer snapshot, and the
  cross-account `BillingRead` row keeps the fields it had.
- **No consumer generation bump.** The view gains an optional field and rebuilds from the same log;
  the absent field decodes as a customer that never recorded one.

## Alternatives considered

- **A rename/update command in the same slice.** It doubles the surface and needs its own decision
  about whether a changed email is a new identity, a support action or a re-verification. This slice
  states the identity once; a rename is its own ADR.
- **A separate customer aggregate.** A second aggregate for the same account is a second writer, a
  second event log and a second idempotency space for one customer, and a command that touches both a
  plan and an identity would become a transaction across two keys. The account is the customer.
- **A customer without an account.** It would make a customer a vendor object keyed by an email with
  no billing identity behind it, which is what the provider's checkout already is. Money must name the
  account the log bills.
- **Creating the customer from a controls write or an activation.** That is today's behaviour, and it
  is why a sign-up flow has to change a guardrail to record a name. A consequence is not a verb.
- **A `Customer` resource or a second read model.** The identity is customer state in the aggregate
  and one field on the page; a resource needs a lifecycle, and a second read model needs a rebuild
  rule, for two strings and a timestamp.
- **Normalizing the details (trimming, lowercasing an email).** It would let two spellings of one
  address compare equal, but it silently rewrites what the customer wrote, and the event is the record
  of what they said. A deployment that wants canonicalization does it before the call.

## What would reopen this

- **A rename or update command**, which turns "different details are a refusal" into a decision about
  who may change an identity and whether the old one is kept.
- **A separate customer aggregate**, for scale or for a customer that can exist without an account.
- **An identity the deployment verifies** — a verified email, a tax id, a billing address — which is a
  workflow and a provider fact, not a latch.
- **A customer that must exist before the account does**, which is a sign-up orchestration decision
  and not a billing rule.
