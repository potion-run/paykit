# 0040 — An entity is a scope, not a customer

- **Status:** Accepted
- **Date:** 2026-11-10
- **Follows:** [0002](./0002-credits-are-the-unit-of-account.md), [0003](./0003-the-deploy-provisions-the-vendor.md), [0034](./0034-one-quint-model-per-protocol.md), [0035](./0035-plans-plan-items-and-balance-sources.md), [0036](./0036-a-seat-is-purchased-and-occupied.md), [0037](./0037-a-lifetime-grant-is-a-balance-source.md)

## Context

[ADR 0035](./0035-plans-plan-items-and-balance-sources.md) put `Entity` in the vocabulary — "a
child scope under a customer, with its own plans and balances" — and decided nothing else about it.
The queue's next slice asks for entity-scoped plans and balances and `billing.transfer`, and the
design has two tempting wrong answers.

The first is an entity as a second customer. It makes a plan bought for the parent and a plan bought
for a child two aggregates, two event logs and two writers. A transfer between them is then a
distributed transaction, and two commands that should be one bill can fail apart.

The second is an entity as a label on a balance. A label cannot hold its own plan, so "this team has
its own allowance" is not expressible, and the parent's balance has to explain which part of itself
belongs to whom.

The transfer raises a third question at the unit level. If balances are scopes, what moves between
them, what must not move, and how does a report add scopes without counting the shared pool twice?
Archiving adds a fourth: what happens to the entity's plans, balances and occupancy, when
[ADR 0003](./0003-the-deploy-provisions-the-vendor.md) says nothing a bill references is deleted.

## Decision

**1. An entity is a child scope under exactly one customer.** It has a branded `EntityId` and a
`parentId: CustomerId`, and the hierarchy is one level: an entity has no children. Nested entities
are a later ADR, because they need a path, inherited plans and a cycle rule. A command names its
scope as `ScopeRef = { kind: "customer" } | { kind: "entity", entityId }`, so a bare string cannot
stand in for a customer or an entity by accident. An entity id is never reused after archiving.

**2. The customer is the single writer.** One aggregate per customer owns every command for that
customer and every one of its entities. An entity has no aggregate, no command stream and no
`commandId` of its own; `entityId` rides in the command and in the event, and the customer's
transaction commits the events, state, receipt and deliveries for a write on any of its scopes.
Ordering and dedupe are the customer's. A read for an entity is a filtered read of the customer's
view, keyed by the customer: an entity is a partition of one state, not a second key, until a
per-entity projection is justified. This is ADR 0035's "one writer per account" applied to a
partition.

**3. An entity holds its own plan set and its own balance sources.** A plan item names its scope;
attaching it on an entity writes that entity's plan set. A plan item may be `pooled`: its grant
belongs to the parent and every attached entity of that customer draws on the same source. A pooled
item is attached on the customer (`pooled: true` is valid only for the customer scope); an
entity-scoped item is attached on that entity. A pooled item on an entity would be a second pool.

Deduction for an entity is its own plan source, its own rollover, its own expiring grant, its own
lifetime grant, and then the pooled source. A scope spends what it owns before the shared pool, and
within a class [ADR 0037](./0037-a-lifetime-grant-is-a-balance-source.md)'s order applies. The
customer's close replaces the plan and rollover sources of every attached scope and of the pool; it
leaves every lifetime grant alone.

**4. `Balance.breakdown` reports ownership and the shared row.** Every source carries a `sourceId`,
the `scope` that owns it and its `kind`. A pooled source carries `pooled: true`, and its owner is the
customer.

- An **entity-owned** source appears only on that entity's balance and, marked with its entity
  scope, in the customer's fold.
- A **pooled** source appears once on the customer's balance as its own row, and on every attached
  entity's balance as a `pooled: true` row whose `remaining` is the pool's remaining. It is the same
  number for every entity: an entity's row is what it may spend of the shared source, not a copy it
  owns. An archived entity has no pooled row.
- The customer's balance is the fold over the sources it owns and its entities' sources, with the
  pooled source counted once. A report that adds scopes dedupes by `sourceId`; adding entity totals
  counts the pool once per entity, which is why the breakdown carries the owner. `Balance.total` for
  an entity is what that entity may spend; the customer-level total is the deduped fold.
- A source that arrives by transfer keeps its kind and deadline. The target's breakdown row names
  the kind and the deadline; `BalanceTransferred` in the log names where it came from.

**5. `transfer` is one command, one transaction, one event.**
`transfer({ customerId, from, to, featureId, amount, commandId })` names two scopes of one customer.
It records one `BalanceTransferred` event carrying `from`, `to`, `featureId`, `amount`, the split by
source kind (`plan`, `grant`), the deadline it applied and `remainingAfter` for both scopes. The
command is idempotent by `commandId`; a retry is a replay, not a second move.

A transfer conserves the total across the customer's scopes: the source's deduction and the target's
credit are the same number. It deducts from the source in ADR 0037's order — plan, rollover,
expiring grant, lifetime grant — and credits the target in the same class: plan units stay plan,
lifetime units stay lifetime. A transfer can shorten a deadline, because the target receives the
earlier of its own deadline and the transferred units' deadline; it can never extend one. It is not
a provider call, an invoice or a proration: it moves no money and records no price.

**6. What a transfer may not do.**

- **Cross customers.** Both endpoints must belong to the command's `customerId`:
  `TransferAcrossCustomers`. Another customer's scope is refused by the aggregate with a typed
  refusal, not hidden by a type that cannot express the mistake.
- **Move occupancy.** It moves balance units, never `purchased` or `occupied`
  ([ADR 0036](./0036-a-seat-is-purchased-and-occupied.md)). Seats move by `SetUsage` on the target and
  `SetQuantity` on the source — two facts, never one side effect. A seat is a person's access, not a
  number to teleport.
- **Move a credit system's credits.** A credit system is one pool per customer
  ([ADR 0002](./0002-credits-are-the-unit-of-account.md)) and is not entity-scoped:
  `TransferOfCreditSystem`. An entity reaches credits through a pooled plan item; moving them between
  scopes would be a second pool.
- **Move from or into a pooled source.** `TransferOfPooledSource`. The pool is a plan item on the
  parent, attached and closed, not topped up by a transfer; a transfer writes own sources only.
  Topping up the pool is an attach.
- **Address an archived or detached scope.** `TransferFromArchivedScope` /
  `TransferToArchivedScope`. An archived entity holds nothing and a detached one has no balance.
- **Move a non-positive amount, more than the source owns, or to itself.** `TransferAmountNotPositive`,
  `TransferExceedsBalance`, `TransferSameScope`. A transfer does not borrow from the pool or from a
  sibling.
- **Turn a lifetime grant into an expiring one.** The class is preserved, so a transfer cannot be
  used to extend a grant's life.

**7. Entity lifecycle: detached → attached → archived.**
`EntityArchived` is terminal: a new entity is a new id, never a reopened one, because a reappearing
id would make old bills and old balances ambiguous. Archiving sweeps the entity's unspent own sources
to the parent in the same command and event, and the event carries `returned` per feature and class.
The entity holds nothing; the parent's plan and lifetime sources receive the units; nothing is
destroyed. A close after the archive does not grant the entity a new plan — its plan sources ended at
the archive — and the pool, which belongs to the parent, stays.

Archiving is refused while the entity has occupancy: `EntityHasOccupancy`. An operator sets
occupancy to zero first, because evicting a user is never a billing side effect. The event log, the
entity's history and every bill it produced are retained
([ADR 0003](./0003-the-deploy-provisions-the-vendor.md)); archive is a state on the customer's
aggregate, not a delete. The entity create and archive operations are commands on that aggregate;
their names land with their `*.command.ts`, and the ADR names the events (`EntityAttached`,
`EntityArchived`) rather than a binding.

**8. The change is additive.** `entityId` is optional on commands and events; absence means the
customer scope, so a state with no entities decodes as one scope. The customer's state gains
`entities`, every source gains a `scope`, and the balance view's consumer generation bumps so the
a rebuild replaces it. `BalanceTransferred` is append-only like every other event: a field may be
added, never renamed or repurposed.

## Consequences

- `specs/paykit/entities.qnt` is the model: one customer, a parent scope, two entities, one pooled
  plan item and one entity-owned balance, a lifetime grant and the transfer. Its invariants are
  named so each maps to a decision above (`README.md` has the table).
- One aggregate per customer grows with its entity count. A customer with many entities and high
  usage is a hot key; if that becomes the limit, a per-entity aggregate is a different decision and
  the transfer becomes a two-writer operation.
- The API gains `entityId` on `check`, `track`, `balances`, `attach` and `update`. The old call shape
  is the customer scope, so no caller breaks.
- A naive sum of entity balances overcounts a pooled source. Every report that adds scopes is a fold
  over `Balance.breakdown` deduped by `sourceId`.
- Archiving a busy entity takes two steps: set occupancy to zero, then archive. That is deliberate;
  the alternative is an eviction the billing layer is not allowed to perform.
- A transfer is decided from the two scopes' sources and needs no clock, provider or catalog lookup,
  so `decide` stays pure.
- `Balance.total` for an entity answers "what this entity may spend"; it is not a share of the
  customer's total. The owner on each row is what makes the customer total computable.

## Alternatives considered

- **An entity as its own aggregate or customer.** Rejected: two writers for one bill, two
  idempotency spaces, and a transfer that is a distributed transaction. It also turns a
  cross-customer transfer into a transaction to implement instead of a refusal to state.
- **An entity as a label on the customer's balance.** Rejected: no entity plan set, no entity
  balance, and no way to express "this team has its own allowance".
- **A nested hierarchy now.** Rejected for this slice: one level is what the brief asks for; nesting
  needs a path, inheritance and a cycle rule, and none of those is decided here.
- **`transfer` as a separate debit and credit command.** Rejected: a crash between them destroys or
  mints units. One `decide` is the only place an all-or-nothing pair can be decided, the same rule
  [ADR 0032](./0032-a-refund-may-revoke-credits-in-one-call.md) applies to a refund and its
  revocation.
- **A per-entity copy of a pooled grant.** Rejected: it is a double grant, and one entity's spend is
  invisible to its sibling. One source with one remaining is the only shape that conserves the pool.
- **Archiving by deleting the entity, its balances or its bills.** Rejected: replay, ADR 0003, and
  the support case where a bill names an entity that no longer exists.
- **Moving occupancy with the balance.** Rejected: ADR 0036. A billing move never evicts a user.
- **Entity-scoped credit systems.** Rejected: ADR 0002's one pool per customer. Reopening it needs an
  ADR that changes what a credit is, not a flag on a transfer.

## What would reopen this

- Nested entities, or an entity that can move to another customer. `parentId` would become mutable
  and the cross-customer rule would need a migration rather than a refusal.
- A per-entity aggregate for scale, which makes the transfer a two-writer operation with its own
  consistency question.
- A credit system that becomes entity-scoped, or a second pool per customer.
- Per-scope billing periods with different deadlines, where a transfer must split by deadline instead
  of preserving one class.
- A requirement to move occupancy with a balance. That is a different command with an eviction rule,
  and [ADR 0036](./0036-a-seat-is-purchased-and-occupied.md) is why it is not this one.
