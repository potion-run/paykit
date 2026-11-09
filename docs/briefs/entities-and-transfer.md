# Brief — entities and transfer

This is the working plan for the Phase 6 slice: entity scopes, pooled plan items and
`billing.transfer`. It is a brief, not an ADR: the decisions are in
[0040](../adr/0040-an-entity-is-a-scope-not-a-customer.md), with
[0035 §3–4](../adr/0035-plans-plan-items-and-balance-sources.md),
[0037](../adr/0037-a-lifetime-grant-is-a-balance-source.md) and
[0039](../adr/0039-one-plan-per-group-and-add-ons-stack.md). Where this brief and an ADR disagree,
the ADR wins.

It lands **after the plan set**. It assumes the plan set's shape and says so below; it does not
re-open it. This pane writes no `packages/**`, no `specs/**` and no `docs/adr/**`.

## Rules

- **The customer is the single writer.** One aggregate per customer owns every command for it and
  all its entities. `entityId` is command data, never a second `AccountId`, aggregate, receipt or
  view key. One command id, one transaction, one ordered log.
- **An entity is a scope, not a customer.** It has its own plan set and its own balance sources, and
  no second standing. A read with `entityId` is a filtered read of the customer's view.
- **A pooled item rolls up once.** The pool is one source owned by the customer. Every attached
  entity's breakdown names the same `sourceId` and `remaining`; a report that adds scopes dedupes by
  `sourceId`, and an archived entity has no pooled row.
- **A transfer conserves and stays inside.** One command, one event, one source class at a time.
  It does not cross customers, move occupancy, move a credit system's credits, write the pooled
  source, or extend a deadline.
- **Nothing a bill references is deleted.** Archive sweeps the entity's unspent own balance to the
  parent, rewrites no event and keeps the record, its plans and its bills.
- **The model is the gate.** `specs/paykit/entities.qnt` has 9 invariants, 9 mutants and 14 named
  scenarios. Every action has a coverage row; `attachEntity`, `archiveEntity` and `transfer` sit in
  `MACHINE_ACTIONS` until `AttachEntity.command.ts`, `ArchiveEntity.command.ts` and
  `TransferBalance.command.ts` land, and each then takes its command row.

## Status

The ADR and the model are in; the TypeScript is not. The gap, checked against the tree:

| Claim | Evidence |
| --- | --- |
| No entity on the customer | `Customer.ts:123` `export const Customer = Schema.Struct({ id, name, email, plans, billingControls })` — no `entities` |
| No scope on a balance | `Balance.ts:20` `BalanceSource` has `id, kind, granted, remaining, usage, interval, planId, expiresAt, resetAt`; `Balance.ts:60` `Balance` has no `scope` |
| One aggregate per customer | `Subscription.state.ts:54` `AccountId`; `:438` `SubscriptionState = Schema.Union([UnsubscribedState, SubscribedState])` |
| The plan set is not in yet | `Subscription.state.ts:288` `tier: Schema.String`; `:415` `allowances: Allowances`; `:421` `pendingTier` |
| No entity on a balance command | `GrantBalance.command.ts:51`, `TrackUsage.command.ts:132`, `SetQuantity.command.ts:65`, `SetUsage.command.ts:45` — inputs carry `feature`, not `entity` |
| No entity on a balance read | `Balances.binding.ts:30` `BalanceGetRequest = Schema.Struct({ featureId })` |
| No entity on attach | `Attach.binding.ts:60` `AttachRequest` — `planId`, `featureQuantities`, `planSchedule`, `prorationBehavior`, `idempotencyKey` |
| No entity or transfer command on the Api | `BillingApi.api.ts:11` `commands: [...]` — no `AttachEntity`, `ArchiveEntity` or `TransferBalance` |
| No entity export | `Read.ts:186` exports `Customer`, no `Entity` or `EntityId` |
| The read row has one scope | `BillingReadStore.ts:12` `BillingReadRow` — one `features` map, no `entities` |
| The customer read has no entity list | `Customers.layer.ts:30` `customerOf` builds `plans` and `billingControls` only |
| The atom client is closed | `Atom.ts:116` `BillingAtomVerb` — no entity or transfer verb |

The model is green: `pnpm spec`, `spec:test`, `spec:mutants` (9 for entities, 53 total) and
`spec:coverage` (39 commands, 7 specs).

## The plan-set assumption

The plan set ([0039](../adr/0039-one-plan-per-group-and-add-ons-stack.md),
`schedules.qnt`) lands first. This brief assumes:

1. **A plan set replaces `tier`/`allowances`.** ADR 0039 §1: "the plan set is a map from group to
   one plan"; §2: an add-on stacks beside it. Today `Subscription.state.ts:288`/`:415` is still the
   single `tier`/`allowances`, so the plan-set slice is a prerequisite, not a parallel branch.
2. **The plan set is per scope.** The customer's top-level set stays; each `EntityRecord` gains
   `plans: PlanSet`. `attach`, `update`, `previewAttach` and `previewUpdate` gain `entityId?` and
   write that scope's set. A phase names a scope and a group, never a customer.
3. **The close applies each scope's set.** At the boundary the scope's plan source is replaced and
   its lifetime grants are untouched (ADR 0039 §9, ADR 0037 §2). An archived scope is skipped.
4. **One plan per group and add-ons stack inside one scope.** ADR 0039 §1–2 is unchanged; it is
   applied once per scope, so two entities may each hold a plan in the same group.
5. **A plan item carries `pooled?: boolean`.** ADR 0040 §3: `pooled: true` is valid only on the
   customer's scope, and a pooled item on an entity is `PooledItemOnEntity`. The catalog's
   `PlanItem` and the state's `Allowance` carry the flag; `planItemsOf` copies it.

If the plan set lands customer-wide only, the entity branch has no state; that is Open question 1.

## Target surface

```ts
import * as Effect from "effect/Effect";
import * as Paykit from "@potion.run/paykit";

const messages = Paykit.feature({ id: "messages", name: "Messages" });

// `pooled` is catalog data: the grant belongs to the customer (ADR 0040 §3).
const pool = Paykit.plan({
  id: "pool",
  name: "Shared pool",
  grants: [Paykit.planItem(messages, { included: 10_000, pooled: true })],
});

export const entities = (customerId: Paykit.CustomerId) =>
  Effect.gen(function* () {
    const entities = yield* Paykit.Entities(customerId);

    const support: Paykit.Entity = yield* entities.create({
      entityId: Paykit.EntityId.make("ent_support"),
      name: "Support",
    });
    const one: Paykit.Entity = yield* entities.get(support.id);
    const all: ReadonlyArray<Paykit.Entity> = yield* entities.list();
    const renamed: Paykit.Entity = yield* entities.update({
      entityId: support.id,
      name: "Support EU",
      idempotencyKey: "rename-support-1",
    });
    const archived: Paykit.Entity = yield* entities.archive({
      entityId: support.id,
      idempotencyKey: "archive-support-1",
    });

    // `Customer.entities` is the same list on the customer record.
    const customers = yield* Paykit.Customers(customerId);
    const customer: Paykit.Customer = yield* customers.get();
    customer.entities; // ReadonlyArray<Entity>

    // Plan and balance operations take a scope.
    const attach = yield* Paykit.Attach(customerId);
    yield* attach({ entityId: support.id, planId: "team", idempotencyKey: "attach-team-1" });
    yield* attach({ planId: "pool", idempotencyKey: "attach-pool-1" });

    const balances = yield* Paykit.Balances(customerId);
    const own: Paykit.Balance = yield* balances.get({
      entityId: support.id,
      featureId: "messages",
    });
    own.scope; // { kind: "entity", entityId: "ent_support" }
    own.breakdown; // own rows, then the pooled row: { scope: customer, pooled: true }

    // One transfer. `billing.transfer` is the operation spelling of this verb.
    const transfer = yield* Paykit.TransferBalance(customerId);
    const moved: Paykit.TransferBalanceResult = yield* transfer({
      from: { kind: "entity", entityId: Paykit.EntityId.make("ent_a") },
      to: { kind: "entity", entityId: Paykit.EntityId.make("ent_b") },
      featureId: "messages",
      amount: 250,
      idempotencyKey: "transfer-1",
    });
    moved.from.remaining; // the source scope after the move
    moved.to.remaining; // the target scope after the move

    return { support, one, all, renamed, archived, customer, own, moved };
  });
```

Exact public names, and nothing else:

| Name | Kind | Shape |
| --- | --- | --- |
| `EntityId` | branded schema | `Schema.String.pipe(Schema.brand("EntityId"))` |
| `EntityStatus` | schema literal | `"attached" | "archived"` — `detached` is the absence of a record, not a read status |
| `Entity` | `Schema.Struct` | `{ id, parentId, name?, status, createdAt, archivedAt? }` |
| `Customer.entities` | field | `ReadonlyArray<Entity>` |
| `Entities` | `Binding.Service` | `Paykit.Entities(customerId)` → `create`, `get`, `list`, `update`, `archive`; `EntitiesVerb`, `EntityCreateRequest`, `EntityUpdateRequest`, `EntityArchiveRequest`, `EntitiesError` |
| `TransferBalance` | `Binding.Service` | `Paykit.TransferBalance(customerId)` → the transfer verb; `TransferBalanceVerb`, `TransferBalanceRequest { from, to, featureId, amount, idempotencyKey }`, `TransferBalanceResult { amount, from, to }`, `TransferBalanceError`; the operation is `billing.transfer(...)` |
| `ScopeRef` | schema union | `{ kind: "customer" } | { kind: "entity", entityId }` |
| `Balance.scope` | field | the `ScopeRef` the balance was asked for |
| `BalanceSource.scope` | field | the owner: customer or entity |
| `BalanceSource.pooled` | optional field | `true` only on the shared row |
| `PlanItem.pooled` / `Allowance.pooled` | optional field | catalog and state copies of one flag |
| `AttachEntity`, `UpdateEntity`, `ArchiveEntity`, `TransferBalance` | commands | events below |
| `EntityAttached`, `EntityUpdated`, `EntityArchived`, `BalanceTransferred` | events | below; the event class for the `EntityArchived` tag is `EntityArchivedEvent`, because the refusal class takes `EntityArchived` |

## The decide table

`decide` stays pure: every scope lookup reads `state.entities`, every catalog fact a command needs
travels in the command or in the standing (`state.rates`). `entityId` is optional on the four
scoped commands; absent means the customer scope, so the old call is unchanged.

| Command | Reads | Events | Refusals | Notes |
| --- | --- | --- | --- | --- |
| `AttachEntity` | `state.entities[id]` | `EntityAttached` | `EntityExists`, `EntityArchived` | `entities.create`; `entityId` is the command id, so a retry replays; an existing id is `EntityExists`, an archived one is `EntityArchived` (terminal wins) |
| `UpdateEntity` | the record | `EntityUpdated` | `EntityUnknown`, `EntityArchived` | no-op when the name is unchanged |
| `ArchiveEntity` | the record, every `occupied` count, the own sources and quantities | `EntityArchived { returned, returnedQuantities }` | `EntityUnknown`, `EntityArchived`, `EntityHasOccupancy` | sweeps own plan/rollover/grant units and a zero-occupancy purchase to the parent; a second archive is `EntityArchived`, a retry replays |
| `TransferBalance` | both scopes, `state.rates[feature]`, `state.allowances[feature].pooled` | `BalanceTransferred` | `EntityUnknown`, `EntityArchived`, `TransferOfPooledSource`, `TransferOfCreditSystem`, `TransferExceedsBalance` | one event; `plan`/`grant` split; `fromAfter`/`toAfter`; `TransferCrossCustomer` is a binding guard, see Open questions |
| `GrantBalance` + `entity?` | the entity scope's `allowances`, `grants`, `remaining` | `BalanceGranted { entity? }` | + `EntityUnknown`, `EntityArchived` | the grant is entity-owned; a pooled item is not a grant |
| `TrackUsage` + `entity?` | the entity scope's allowance and usage, the shared pool | `UsageRecorded { entity?, poolAfter? }` | + `EntityUnknown`, `EntityArchived` | own plan, own rollover, own grant, then the pool; `remainingAfter` is the scope's own, `poolAfter` the shared number |
| `SetQuantity` + `entity?` | the entity's `quantities` | `QuantityChanged { entity? }` | + `EntityUnknown`, `EntityArchived` | a purchase is per scope; `EntityHasOccupancy` is the archive rule |
| `SetUsage` + `entity?` | the entity's `occupied` | `UsageSet { entity? }` | + `EntityUnknown`, `EntityArchived` | occupancy is per scope; an archived entity holds none |
| `ClosePeriod` | every attached scope's plan set | `PeriodClosed`, one `UsageReset`/`PlanItemReset` per scope, `PlanChanged { entity? }` for a pending phase | — | plan sources reset, lifetime grants stay, archived scopes are skipped |
| `ExpireGrant` / `ResetAllowance` | the grant's or window's scope | `BalanceExpired { entity? }` / `PlanItemReset { entity? }` | — | a deadline on an archived scope records nothing, like a late deadline |

`TransferBalance` in order: resolve both scopes (`EntityUnknown`/`EntityArchived`), refuse a credit
system (`state.rates[feature]` is the same fact `GrantBalance` uses for `FeaturePricedInCredits`),
refuse a pooled customer endpoint, refuse `amount > ownBalanceOf(from)`, then record one event. It
never reads a provider, a catalog or a clock.

Refusals, with the evidence an operator needs:

| Refusal | Kind | Evidence | When |
| --- | --- | --- | --- |
| `EntityUnknown` | `Domain.Rejection` | `{ account, entityId }` | a command names an id that is not in `state.entities` |
| `EntityExists` | `Domain.Rejection` | `{ entityId }` | `AttachEntity` on an id that already exists |
| `EntityArchived` | `Domain.Rejection` | `{ entityId, archivedAt }` | any write on an archived entity, including a second archive |
| `EntityHasOccupancy` | `Domain.Rejection` | `{ entityId, occupancy: [{ featureId, occupied }] }` | `ArchiveEntity` while any occupancy is positive |
| `TransferOfPooledSource` | `Domain.Rejection` | `{ from, to, featureId }` | an endpoint is the customer scope for a `pooled` item |
| `TransferOfCreditSystem` | `Domain.Rejection` | `{ featureId }` | `state.rates[feature]` is set; a credit system is one pool per customer (ADR 0002) |
| `TransferExceedsBalance` | `Domain.Rejection` | `{ from, featureId, amount, available }` | `amount` is past the source scope's own sources |
| `PooledItemOnEntity` | `Domain.Rejection` (Attach) | `{ entityId, planId, featureId }` | a `pooled: true` item is attached on an entity |
| `TransferCrossCustomer` | binding `Schema.TaggedError` | `{ customerId, from, to }` | a scope resolves to another customer; not reachable in `decide` with the ADR's `ScopeRef` — Open question 2 |
| `Forbidden` / `Unauthenticated` | guard | — | the Api's `Session` |

What is a schema failure and what is not:

| Failure | Kind | Where |
| --- | --- | --- |
| a `ScopeRef` with an unknown `kind`, or `kind: "entity"` without an `entityId` | schema failure | `Schema.Union` |
| `amount <= 0` | schema failure | `Schema.check(Schema.isGreaterThan(0))` on `TransferBalanceRequest` |
| `from` and `to` name the same scope | schema failure | a `Schema.filter` on the request; no state is needed |
| an empty or over-long `name`, an empty `entityId` or `idempotencyKey` | schema failure | `Schema.NonEmptyString` / `Schema.maxLength` |
| `EntityUnknown`, `EntityExists`, `EntityArchived`, `EntityHasOccupancy`, `TransferOfPooledSource`, `TransferOfCreditSystem`, `TransferExceedsBalance` | tagged refusal | `decide` |
| `PooledItemOnEntity` | tagged refusal | the attach operation, beside `PlanNotInCatalog` |
| `TransferCrossCustomer` | binding refusal | `TransferBalance.binding.ts`; `decide`'s `EntityUnknown` is the in-model fallback |

`decide` still returns `[]` for a non-positive amount as a replay guard, the way `GrantBalance` does
for `granted <= 0` (the schema has already refused it).

## State and events

Public shapes, in `Customer.ts` and `Balance.ts`:

```ts
export const EntityId = Schema.String.pipe(Schema.brand("EntityId"));
export const EntityStatus = Schema.Literals(["attached", "archived"]);

export const Entity = Schema.Struct({
  id: EntityId,
  parentId: CustomerId,
  name: Schema.optionalKey(Schema.String),
  status: EntityStatus,
  createdAt: Schema.DateTimeUtc,
  archivedAt: Schema.optionalKey(Schema.DateTimeUtc),
});

export const Customer = Schema.Struct({
  // ...id, name, email, plans, billingControls
  entities: Schema.Array(Entity),
});

// src/Balance.ts — the scope every balance and source reports.
export const ScopeRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("customer") }),
  Schema.Struct({ kind: Schema.Literal("entity"), entityId: EntityId }),
]);
// Balance.scope: ScopeRef
// BalanceSource.scope: ScopeRef, BalanceSource.pooled: optionalKey(Boolean)
```

The aggregate keeps the customer scope at the top and the entities beside it. The record reuses
the plan set and the source types; it does not copy the standing:

```ts
// src/Subscription/Subscription.state.ts
export const ScopeState = Schema.Struct({
  plans: PlanSet, // ADR 0039; one set per scope
  allowances: Allowances,
  remaining: Remaining,
  usage: Schema.optionalKey(UsageCounts),
  resetAt: Schema.optionalKey(ResetWindows),
  grants: Schema.optionalKey(BalanceGrants),
  quantities: Schema.optionalKey(QuantityCounts),
  occupied: Schema.optionalKey(OccupancyCounts),
});

export const EntityRecord = Schema.Struct({
  ...ScopeState.fields,
  id: EntityId,
  name: Schema.optionalKey(Schema.String),
  status: EntityStatus, // "detached" is no record at all
  createdAt: Schema.DateTimeUtc,
  archivedAt: Schema.optionalKey(Schema.DateTimeUtc),
});

// On both UnsubscribedState and SubscribedState, like `billingControls`:
entities: Schema.optionalKey(Schema.Record(Schema.String, EntityRecord)),
```

Events, in each command file:

```ts
export class EntityAttached extends Domain.Event("EntityAttached", {
  entity: EntityId,
  name: Schema.optionalKey(Schema.String),
  at: Schema.DateTimeUtc,
}) {}

export class EntityUpdated extends Domain.Event("EntityUpdated", {
  entity: EntityId,
  name: Schema.optionalKey(Schema.String),
}) {}

// The tag is `EntityArchived`; the class is `EntityArchivedEvent` because the
// refusal below owns the plain `EntityArchived` identifier. The serialized tag
// is what the event log and the ADR name.
export class EntityArchivedEvent extends Domain.Event("EntityArchived", {
  entity: EntityId,
  at: Schema.DateTimeUtc,
  /** The own sources the archive moved to the parent, per feature and kind. */
  returned: Schema.Array(Schema.Struct({
    feature: Schema.String,
    kind: BalanceSourceKind,
    amount: Schema.Int,
    interval: Schema.String,
    expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  })),
  /** A purchase with no occupancy moves to the parent; no money moves. */
  returnedQuantities: Schema.Array(Schema.Struct({
    feature: Schema.String,
    quantity: Schema.Int,
  })),
}) {}

export class BalanceTransferred extends Domain.Event("BalanceTransferred", {
  /** The command id, so a target grant created by the move has a stable id. */
  transferId: Schema.String,
  from: ScopeRef,
  to: ScopeRef,
  feature: Schema.String,
  amount: Schema.Int,
  /** The plan/rollover part and the lifetime part; their sum is `amount`. */
  plan: Schema.Int,
  grant: Schema.Int,
  /** The source's reset interval and the earlier deadline it now carries. */
  interval: Schema.String,
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  fromAfter: Schema.Int, // the source scope's own remaining
  toAfter: Schema.Int, // the target scope's own remaining
}) {}
```

The existing events gain one field, never a rename: `PlanChanged`, `BalanceGranted`,
`BalanceExpired`, `UsageRecorded`, `UsageReset`, `PlanItemReset`, `QuantityChanged` and `UsageSet`
gain `entity?: EntityId`. `UsageRecorded` also gains `poolAfter?: Schema.Int` so replay reproduces
the shared pool when an entity draws it; `remainingAfter` stays the scope's own. `PeriodClosed`,
`CreditsExpired`, `CreditsConsumed` and `CreditsPurchased` stay customer-level: a credit system is
one pool per customer (ADR 0002, ADR 0040 §6).

Replay rules:

- `EntityAttached` creates an empty scope; `plans`, `allowances` and `remaining` start empty.
- `EntityArchived` is the only record of the sweep. Its `returned` entries are applied to the
  parent's sources and its `returnedQuantities` to the parent's purchases in the same fold; the
  entity's `plans`, `allowances`, `remaining`, `grants`, `quantities` and `occupied` are cleared.
  A retry with the same command id replays; a new archive is `EntityArchived` (the refusal), while
  the event tag is the same string. This is the one name collision in the slice: the event class is
  `EntityArchivedEvent` and the refusal class is `EntityArchived`, so both keep the ADR's
  serialized tag.
- `BalanceTransferred` is one event. Its `plan`/`grant` split is the source's classes; the fold
  credits the target's own source of that class. A plan-class unit that lands where the target has
  no plan item becomes an expiring `BalanceGrantRecord` with the event's `expiresAt` and
  `transferId` (Open question 3); a lifetime unit becomes a lifetime grant. `fromAfter`/`toAfter`
  are the scopes' own remaining after both sides, so a replay needs no second read.
- A `UsageRecorded` with `entity` writes the entity's `remaining`/`usage` and, when it drew the
  pool, the customer's `poolAfter`; `poolAfter` is absent when the spend stayed in the scope.
- A `GrantBalance`/`SetQuantity`/`SetUsage`/`PlanItemReset` with `entity` writes that scope's maps;
  absent writes the customer's, exactly as today.

**Versioning.** The change is additive: absent `entity` means the customer scope, and absent
`entities` means no entity was ever created, so an old log means exactly what it meant. The state
shape changes, so bump the generations of `Entitlements`, `BillingState` and `BillingRead`; the
platform backfills them from the log. No event is rewritten, and no migration reads state. The SQL
read table gains a nullable `entities TEXT` column in a new additive migration (`0002_entities`);
the projection writes it and `doctor` compares it.

## The read model

`Balance` reports a scope, not a total:

- `Balance.scope` is the requested scope. `balanceOf` (customer) and `balanceOfEntity` build the
  same shape; `balanceOfFeature` takes a `ScopeRef` and stamps `scope` on the `Balance` and on every
  `BalanceSource`.
- An **entity-owned** source carries `scope: { kind: "entity", entityId }` and appears only on that
  entity's balance.
- A **pooled** source is the customer's plan source. It appears on the customer's balance as its
  own row, and on every attached entity's balance with `scope: customer`, `pooled: true` and the
  same `id` and `remaining`. The entity's `remaining` is its own sources plus the pooled row; the
  pool is one row, not one per entity. An archived entity has no pooled row.
- The **customer-level report** is a fold over the customer's `Balance` and each entity's `Balance`,
  deduped by `BalanceSource.id`; it is not `Balance.remaining` of the customer scope. The console
  builds it from `Customer.entities` and `Balances.get({ entityId })`, and `BillingReadRow.entities`
  is the list-path equivalent.
- `check`/`track`/`balances` with `entityId` read the entity's snapshot; `check` on an archived
  entity answers `allowed: false` with an empty balance, while a write refuses `EntityArchived`.
  `check` on an unknown id is `EntityUnknown`.

`Customer.entities` comes from `BillingStateView.entities`; `customerOf` maps the record to the
public `Entity` (the plans and balances stay off the customer record).

| Read | Field | From |
| --- | --- | --- |
| `Balance` | `scope`, `breakdown[*].scope`, `breakdown[*].pooled` | `balanceOfFeature` with a `ScopeRef` |
| `Customer` | `entities` | `BillingStateView.entities` |
| `BillingStateView` | `entities: Array<{ id, name?, status, createdAt, archivedAt? }>` | `EntityAttached`/`EntityUpdated`/`EntityArchived` |
| `EntitlementsState` | `entities: Record<EntityId, { status, features }>` | the same events plus the scoped `UsageRecorded`/`BalanceGranted`/`QuantityChanged`/`UsageSet`/`PlanItemReset`/`PlanChanged` |
| `BillingReadRow` | `entities?: Record<EntityId, { status, name?, features }>` | `BillingRead.projection` from `EntitlementsState.entities` |
| SQL `billing_rm_billing_read` | `entities TEXT` (JSON) | the row above; `features` remains the customer scope, so the pool is stored once |

The SQL row carries the customer's `features` unchanged and the entity-owned `features` under
`entities`; it does not duplicate the pooled row. `Check.rowToState` gains an entity branch:
`row.entities[entityId].features` plus the customer-level `credits`, `billingControls`, `period` and
`standing`. `doctor`'s `rowFromState` and the `BillingRead` projection both write the same map, so a
rebuild and a stored row agree.

The console needs three things: the entity list with status (`BillingStateView.entities`), the
selected scope's `Balance` (`Balances.get({ entityId })`), and the source row the transfer dialog
shows as its ceiling (`Balance.breakdown` + `remaining`). It needs no new cross-account read.

## Test matrix

| Case (model scenario) | File | Proves |
| --- | --- | --- |
| two entities, each with its own plan (`entityHasItsOwnPlanTest`) | `test/billing/Entities.test.ts` | `attach({ entityId })` writes that scope only; the sibling and the customer keep theirs |
| a pooled grant drawn by two (`pooledGrantDrawnByTwoEntitiesTest`) | `test/billing/Entities.test.ts` | `pooled: true` is one source; one entity's spend lowers the other's `remaining` and the same `sourceId` is on both breakdowns |
| a transfer conserves (`transferConservesTheTotalTest`) | `test/billing/Transfer.test.ts` | one `BalanceTransferred`, `from + to` unchanged, both after-values on the event and the read |
| a transfer over the source (`transferBeyondSourceFailsTest`) | `test/billing/Transfer.test.ts` | `TransferExceedsBalance` with `available`; no event |
| a transfer across customers (`transferAcrossCustomersFailsTest`) | `test/billing/Transfer.test.ts` + `test/Api.test.ts` | `TransferCrossCustomer`/`EntityUnknown`; another account is `Forbidden` |
| an archived entity cannot spend (`archivedEntityCannotSpendTest`) | `test/billing/Entities.test.ts` | `EntityArchived` on `TrackUsage`/`GrantBalance`/`TransferBalance`/`SetUsage` |
| an archive returns own sources (`archivedEntityHoldsNothing`) | `test/billing/Entities.test.ts` | `EntityArchived.returned` moves the balance to the parent; the record holds none |
| a close leaves lifetime sources (`closeLeavesLifetimeSourcesTest`) | `test/billing/Entities.test.ts` | the scope's plan resets, its lifetime grant does not; a second scope closes independently |
| own before pooled (`ownSourcesSpentBeforeThePoolTest`) | `test/billing/Entities.test.ts` | the deduction order and `poolAfter` |
| lifecycle order (`archiveBeforeAttachFailsTest`, `attachTwiceFailsTest`, `archiveIsTerminalTest`) | `test/stories/Entity.story.test.ts` | `EntityUnknown`, `EntityExists`, `EntityArchived`; a retry replays |

Also:

- `test/properties/Entities.test.ts` — generated scripts with the three new commands and `entityId` on
  the four scoped commands; `scopedConservation`, `totalConservedAcrossScopes`, `pooledGrantShared`,
  `archivedEntityHoldsNothing`, `noSpendAfterArchive`; `Agreement.test.ts` compares `decide`, the two
  views and `Balance` for each scope.
- `test/properties/Arbitraries.ts` and `Idempotence.test.ts` — every entity command in the sequence;
  one command id records once.
- `test/bindings/BillingBindings.test.ts` — `Entities` and `TransferBalance` on both layers; the
  tenant layer still provides no operator verb.
- `test/check/Entities.test.ts` — `check`/`track`/`balances` per scope; a pooled balance; an
  archived read is `allowed: false`; an unknown id is `EntityUnknown`.
- `test/sql` — the `0002_entities` column, an upsert/read round trip, `doctor` agreement, and a
  backfill of a row written before the column existed.
- `test/PublicSurface.test.ts` — the names above and no aliases.

## Files to touch, in dependency order

| # | File | Change |
| --- | --- | --- |
| 1 | `packages/paykit/src/Customer.ts` | `EntityId`, `EntityStatus`, `Entity`, `Customer.entities` |
| 2 | `packages/paykit/src/PlanItem.ts`, `Allowance.ts`, `Catalog.ts` | `pooled?: boolean` on the item and the state copy; `planItemsOf` carries it |
| 3 | `packages/paykit/src/Balance.ts` | `ScopeRef`, `Balance.scope`, `BalanceSource.scope`/`pooled`, `balanceOfEntity`, `balancesOfEntity`, `balanceOfFeature` takes a scope |
| 4 | `packages/paykit/src/Subscription/Subscription.state.ts` | `ScopeState`, `EntityRecord`, `entities` on both states, `pooledOf`, `ownBalanceOf`, `entityOf`, `scopeOf` |
| 5 | `packages/paykit/src/Subscription/AttachEntity.command.ts` | command, `EntityAttached`, `EntityExists`, `EntityArchived` |
| 6 | `packages/paykit/src/Subscription/UpdateEntity.command.ts` | command, `EntityUpdated`, `EntityUnknown`, `EntityArchived` |
| 7 | `packages/paykit/src/Subscription/ArchiveEntity.command.ts` | command, `EntityArchivedEvent`, `EntityHasOccupancy`, the `EntityArchived` refusal |
| 8 | `packages/paykit/src/Subscription/TransferBalance.command.ts` | command, `BalanceTransferred`, four refusals |
| 9 | `packages/paykit/src/Subscription/Subscription.aggregate.ts` | `decide`/`evolve`/`commands` for the four; `entity?` branches in `GrantBalance`, `TrackUsage`, `SetQuantity`, `SetUsage`, `PlanChanged`, `ExpireGrant`, `ResetAllowance`, `ClosePeriod`; `poolAfter` |
| 10 | `packages/paykit/src/Subscription/Entitlements.view.ts` | entity scope state, the four event handlers, scoped row handlers, `pooled` row |
| 11 | `packages/paykit/src/Subscription/BillingState.view.ts` | `entities` list, three handlers |
| 12 | `packages/paykit/src/Subscription/BillingRead.projection.ts` | `entities` on the row |
| 13 | `packages/paykit/src/BillingReadStore.ts`, `Store/SqlEventLog.ts`, `Store/Migrations/index.ts` | `entities` schema, column, decode/encode, `0002_entities` |
| 14 | `packages/paykit/src/Doctor.ts` | `rowFromState` carries `entities` |
| 15 | `packages/paykit/src/Check.ts`, `Billing/Check.binding.ts` | `entityId?`, entity state, archived read |
| 16 | `packages/paykit/src/Billing/Entities.binding.ts` | `Entities`, requests, refusals, `EntitiesRead` |
| 17 | `packages/paykit/src/Billing/Entities.layer.ts` | `EntitiesLive` over the three command bindings and the view |
| 18 | `packages/paykit/src/Billing/TransferBalance.binding.ts` + layer | request, result, refusals, command then `Entitlements` read |
| 19 | `packages/paykit/src/Billing/Attach.binding.ts` | `entityId?` on attach/update/previews, `PooledItemOnEntity` |
| 20 | `packages/paykit/src/Billing/Balances.binding.ts` + layer | `entityId?` on list/get/create/update/finalize |
| 21 | `packages/paykit/src/Billing/{GrantBalance,TrackUsage,SetQuantity,SetUsage}.binding.ts` | `entityId?`, the two scope refusals |
| 22 | `packages/paykit/src/Billing/BillingInProcess.layer.ts`, `BillingApi.layer.ts`, `BillingApi.api.ts` | the four commands, `EntitiesRead`, both layers |
| 23 | `packages/paykit/src/Billing/index.ts`, `src/Paykit.ts`, `src/index.ts`, `src/Read.ts` | the bindings, layers, `EntityId`, `Entity`, `ScopeRef`, command classes |
| 24 | `packages/paykit/src/Atom.ts` | `entities(account)` query; `createEntity`, `updateEntity`, `archiveEntity`, `transferBalance`; `BillingAtomVerb` |
| 25 | the tests in the matrix | stories, properties, bindings, check, Api, SQL, public surface |

Steps 1–14 are the model and the read; 15–24 the surface. Nothing here changes the catalog's plan
shape except `pooled`, and nothing rewrites an existing event.

## Gates

The model is already green; the implementation runs the full set:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm spec
pnpm spec:test
pnpm spec:mutants
pnpm spec:coverage
pnpm exports:check
pnpm validate:publish-packages
pnpm build
node scripts/smoke-artifact.mjs
```

## Open questions

1. **Does the plan set land per scope?** The brief assumes one `PlanSet` in each `EntityRecord`
   (ADR 0039 §1 is silent on scope; ADR 0040 §3 says an entity has its own plan set). Today
   `Subscription.state.ts:288`/`:415` is one `tier`/`allowances`. If the plan-set slice keeps one
   customer-wide set, the entity plan branch needs a second state and this brief is wrong before
   step 5.
2. **`TransferCrossCustomer` has no reachable evidence.** ADR 0040 §6 names it, but its `ScopeRef`
   has no customer id and one aggregate sees only its own entities (ADR 0040 §1–2), so a foreign
   entity id is indistinguishable from an unknown one: `decide` answers `EntityUnknown`. The brief
   keeps `TransferCrossCustomer` as a binding-level refusal and `EntityUnknown` as the model answer.
   Adding a `customerId` to `ScopeRef` is the alternative, and it is a schema change to the ADR.
3. **A plan-class transfer into a scope with no plan source.** `BalanceSource` derives a `plan` row
   from `state.allowances[feature]` (`Balance.ts:20`); a target with no item has no `plan` row to
   grow. The brief credits an expiring `BalanceGrantRecord` with the event's `expiresAt` instead,
   which keeps the value and deadline but not `kind: "plan"`; the alternative is
   `TransferToScopeWithoutSource`. Reopen if the ADR's "keeps its kind" (0040 §4) is a read
   contract, not just a value rule.
4. **The SQL read row.** The brief adds one `entities` JSON column to `billing_rm_billing_read`,
   because the row is rebuilt from one log and the list is per customer. An entity-level list or
   paging by entity would need `billing_rm_entity` and a second projection; that is a different
   read model, not a second column.
5. **A purchased seat on an archive.** The command refuses only occupancy and moves a zero-occupancy
   `quantities` count to the parent (the bill stays with the customer). If the deployment bills the
   entity's plan at the vendor, the provider quantity needs a zeroing call before the command; that
   call belongs to the plan-set/attach layer, not `decide`.
6. **Entity-level controls.** ADR 0035 §6 says "customer or entity"; the controls slice landed
   customer-level (ADR 0038). `EntityRecord.billingControls` is deliberately absent; an entity with
   its own ceiling is a later slice.

## What this does not decide

- **Nested entities.** One level only; a child of an entity needs a path, inheritance and a cycle
  rule (ADR 0040 §1).
- **Pooled credit systems.** A credit system is one pool per customer (ADR 0002); `pooled` on a
  credit feature is out, and `TransferOfCreditSystem` refuses the transfer.
- **An operator entity write.** Every verb here is tenant-scoped; a support flow that creates,
  archives or transfers on a customer's behalf is an `Admin` verb with a different blast radius.
- **A transfer fee.** A transfer moves balance units, not money; a fee, a proration or a provider
  call is a different command.
- **Per-entity periods, generated ids and entity-level controls.** The brief uses the customer's
  period, a caller-supplied `EntityId`, and customer-level controls; each would change a shape
  above.
