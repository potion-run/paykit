# Brief — plan, customer and balance API

This is the working plan for the API migration. It is a brief, not an ADR: the decisions are in
[0035](../adr/0035-plans-plan-items-and-balance-sources.md),
[0036](../adr/0036-a-seat-is-purchased-and-occupied.md) and
[0037](../adr/0037-a-lifetime-grant-is-a-balance-source.md). Where this brief and an ADR disagree,
the ADR wins.

No code, comment, doc or test names the product this API is modelled after. The vocabulary is
`plan`, `planItem`, `feature`, `customer`, `balance`, `lifetime grant`.

## Rules

- **Quint before code.** Every state machine has a green model, named scenarios, mutants and a
  coverage row before the implementation that touches it.
- **Alchemy shape.** Plans, plan items and customers are plain `Schema` data. `Resource` is only for
  provider-owned objects. Operations are `Binding.Service`/`Context.Service` with one `Layer`.
- **Types are the contract.** Branded ids, `Schema.Struct` inputs, one tagged-error union per
  operation, `Effect.fn` spans, no `Input<T>` in public props.
- **One operation, one transaction.** `attach` and `update` record their events atomically; a caller
  never has to call a second verb to collect a proration.

## Status

- **Phase 0 — done.** ADRs 0035–0037; `windows.qnt` and `standing.qnt` updated; stale docs fixed.
- **Phase 1 — done.** `Plan`, `PlanId`, `PlanKind`, `PlanTrial`, `PlanItem` and `planItem()` are
  public, the catalog accepts `plans`, and a plan has `group`, `addOn`, `isDefault` and `trial`.
  The internal command and event words are renamed: `PlanChanged`, `PlanChangeScheduled`,
  `PlanNotInCatalog`, `PlanItemReset`; the source helpers are `planOf`, `planTermsOf`,
  `planItemsOf`. `Tier` and `Allowance` remain the schema names while the state migration lands.
- **Phase 2 — done.** `plans.qnt` and its scenarios are green. `Paykit.Attach` implements
  activation, immediate upgrade, scheduled downgrade and feature quantities. `Paykit.Update`
  implements quantities, cancel-at-boundary and uncancel. `PreviewAttach` and `PreviewUpdate`
  expose the same decisions through the existing preview path. The transport surface is in.

  **Transport is in.** `Paykit.handler` serves `POST /plans/attach`, `POST /plans/update`,
  `POST /plans/preview-attach` and `POST /plans/preview-update` with the same schemas the bindings
  use, behind the deployment's `accountOf`.

  **Immediate cancellation is in.** `SubscriptionActivated` and `PaymentRecorded` carry the
  provider's `chargeId`; the standing keeps `lastChargeId`; a priced activation counts toward
  `charged` only when a charge id is present. `CancelImmediately` releases holds, expires plan
  credits, records the provider refund in the same transaction, and leaves a lifetime pack alone.
  `Update` computes the unused part of the plan price and calls `Payments.refund` before sending
  the command.

## Target surface

```ts
paykit.plans.list()
paykit.plans.get(planId)

paykit.customers.getOrCreate({ customerId, name?, email? })
paykit.customers.get({ customerId })
paykit.customers.list({ ...filters })
paykit.customers.update({ customerId, billingControls? })

paykit.billing.attach({ customerId, planId, featureQuantities?, planSchedule?,
                        prorationBehavior?, trial?, carryOverBalances?,
                        carryOverUsages?, invoiceMode? })
paykit.billing.update({ customerId, planId?, featureQuantities?, cancelAction? })
paykit.billing.previewAttach(...)
paykit.billing.previewUpdate(...)
paykit.billing.openPortal({ customerId, planId? })
paykit.billing.verify({ customerId })

paykit.check({ customerId, featureId, requiredBalance?, entityId?,
               lock?, sendEvent?, properties? })
paykit.track({ customerId, featureId, value, idempotencyKey?, properties? })

paykit.balances.list({ customerId, entityId? })
paykit.balances.get({ customerId, featureId, entityId? })
paykit.balances.update({ customerId, featureId, usage, entityId? })
paykit.balances.create({ customerId, featureId, grantedBalance, reset?, expiresAt? })
paykit.balances.finalize({ lockId, action, overrideValue? })
```

## Phases

### Phase 0 — decisions and models (done)

- ADRs 0035, 0036 and 0037 record the vocabulary, the purchased/occupied seat and the lifetime
  source.
- `windows.qnt` now models purchased, occupied and a negative seat balance.
- `standing.qnt` now models `planCredits` and `lifetimeCredits` as separate folds; a close replaces
  the plan source and leaves the lifetime source alone.
- Stale docs (PLAN, AGENTS, NEXT, specs README, FINDINGS) were updated to point at the ADRs.
- Gates: `pnpm spec`, `pnpm spec:test`, `pnpm spec:mutants`, `pnpm spec:coverage`, `pnpm lint`,
  `pnpm typecheck`, `pnpm format:check` all green.

### Phase 1 — vocabulary and catalog (next)

- Add `PlanId`, `PlanItemId`, `CustomerId`, `EntityId`, `BalanceId`.
- Add `Plan`, `PlanItem`, `Feature.type`, `Feature.consumable`, `Plan.group`, `Plan.addOn`,
  `Plan.isDefault`, `Plan.trial`, `PlanItem.reset`, `PlanItem.proration`, `PlanItem.rollover`.
- Allow several items for one feature (a period grant plus a one-off grant).
- Refuse `resets: "never"` on a consumable subscription plan item; keep it for a non-consumable
  seat.
- Decode old `Tier`/`Allowance` state.
- Model gate: catalog expressiveness and old-state decode; no new state machine yet.
- Exit: `Plan`/`PlanItem` public constructors, old `tier`/`allowance` aliases, catalog tests green.

### Phase 2 — attach, update and previews

- Add `billing.attach`, `billing.update`, `previewAttach`, `previewUpdate`.
- `attach` classifies new / upgrade / downgrade / add-on / one-off. A downgrade is scheduled by
  default; a cancellation drops a pending change; `uncancel` removes either a pending cancellation
  or a scheduled change.
- Fold the proration charge into the operation.
- Model gate: `plans.qnt` and the extended `standing.qnt`; classification, cancellation precedence,
  immediate cancellation and default plan.
- Exit: one operation records the change and the money; the old command bindings remain advanced.

### Phase 3 — check, track, balances and locks (done)

- `check` returns a `balance` object and takes `requiredBalance`, `lock` and `idempotencyKey`. A
  lock is a hold; a refused check places nothing, and an allowed one answers `lockId`.
- `track` takes `value` and `idempotencyKey`, returns `{ customerId, featureId, value, balance }`.
- `balances.list/get/update` and `balances.finalize` are in. `balances.update({ usage })` writes
  occupied seats (`SetUsage` -> `UsageSet`); `balances.finalize` commits or releases a lock and is
  `SettleHold` / `ReleaseHold` underneath. The low-level verbs remain the advanced surface.
- `sendEvent` is not a field: recording usage is `track`, which is the transactional write. A
  `check` that wrote usage would make the read a second write path.
- `balances.create` is Phase 4, because a standalone grant is a `BalanceSource` (ADR 0037) and
  needs `balances.qnt` before it can be a write. It has since landed (see Phase 4).
- Model gate: lock finalize once; purchased/occupied; negative balance blocks new occupancy. All
  three were already in `paykit.qnt` and `windows.qnt`; `SetUsage` now has its coverage row, and
  `Quantities.test.ts` pins the purchase/occupancy split.

### Phase 4 — balance sources, rollover and customer controls (sources done)

- **Landed.** `balances.qnt` models a plan source, a rollover, an expiring grant and a lifetime
  grant. The code stores standalone grants on the standing, derives the plan/rollover part as the
  total less the grants, and spends the plan and rollover before a grant. `balances.create`
  (`GrantBalance`) creates a lifetime or expiring grant; `BalanceExpiry` schedules `ExpireGrant`
  at its deadline. A close and a plan change leave every grant alone, and `Balance.breakdown`
  reports plan, rollover and grant sources.
- **Remaining.** A resetting standalone grant is an add-on plan item (Phase 5). Customer controls
  landed in [ADR 0038](../adr/0038-customer-controls-are-state.md) and
  [`controls.qnt`](../../specs/paykit/controls.qnt); the plan set is modelled in
  [ADR 0039](../adr/0039-one-plan-per-group-and-add-ons-stack.md) and `schedules.qnt`, and its
  implementation is the next TypeScript slice.
- Model gate: `balances.qnt`; conservation, deduction order, rollover caps, lifetime survival and
  expiry. `controls.qnt` landed with ADR 0038.
- Exit for the sources half: `Balance.breakdown` is real; `credits` and `prepaidCredits` are still
  derived compatibility fields for the credit pool.

### Phase 5 — multiple plans and schedules (model landed, implementation in progress)

- One active plan per `group`; add-ons stack; different groups stack.
- `PlanSchedule` with phases; `createSchedule`, `multiAttach`, `multiUpdate`; default plan on
  cancellation.
- Model gate: `plans.qnt` and `schedules.qnt`; one plan per group, add-on stacking, phase order,
  no activation after cancel.
- Exit: an account can hold a plan plus add-ons and a multi-phase schedule.

### Phase 6 — entities and transfer (model and brief landed)

- `EntityId` on every operation; entity-scoped plans and balances; pooled items roll up.
- Brief: [entities-and-transfer.md](./entities-and-transfer.md).
- `entities.create/get/list/update`, `billing.transfer`.
- Model gate: `entities.qnt`; entity scope, pooled rollup, transfer conservation.
- Exit: a parent customer can have child entities with their own plans and balances.

## Definition of done per phase

Each phase ends with:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm spec
pnpm spec:test
pnpm spec:mutants
pnpm spec:coverage
```

and a short note in this file saying which model changed, which invariants were added, and which
findings it closes.
