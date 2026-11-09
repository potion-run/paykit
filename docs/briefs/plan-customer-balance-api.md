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
- **Phase 1 — partial.** `Plan`, `PlanId`, `PlanKind`, `PlanTrial`, `PlanItem` and `planItem()`
  are public, the catalog accepts `plans`, and a plan has `group`, `addOn`, `isDefault` and
  `trial`. `attach` maps `planId` to the existing tier terms. The full removal of `Tier` and
  `Allowance` from the public surface, item-level `reset`/`proration` aliases and `Customer` /
  `Balance` schemas remain.
- **Phase 2 — in progress.** `plans.qnt` and its scenarios are green. `Paykit.Attach` implements
  activation, immediate upgrade, scheduled downgrade and feature quantities. `Paykit.Update`
  implements quantities, cancel-at-boundary and uncancel. `PreviewAttach` and `PreviewUpdate`
  expose the same decisions through the existing preview path. The transport surface and the
  collection of quantity proration in the result are next.

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

### Phase 3 — check, track, balances and locks

- `check` returns a `balance` object and takes `requiredBalance`, `lock` and `sendEvent`.
- `track` takes `value` and `idempotencyKey`, returns `{ customerId, value, balance }`.
- `balances.update({ usage })` writes occupied seats; `balances.finalize` confirms or releases a
  lock.
- Model gate: lock finalize once; purchased/occupied; negative balance blocks new occupancy.
- Exit: the low-level `Hold`/`SettleHold`/`ReleaseHold` verbs are advanced, not primary.

### Phase 4 — balance sources, rollover and customer controls

- `BalanceSource` with `kind: "plan" | "addon" | "one_off" | "rollover" | "grant"`.
- Deduction: shorter intervals first, then soonest expiry, lifetime last.
- Plan source replaced at a plan change; lifetime and rollover survive.
- Customer-level auto top-up, spend limits and usage alerts.
- Model gate: `balances.qnt` and `controls.qnt`; conservation, deduction order, rollover caps,
  lifetime survival, spend limit and top-up.
- Exit: `Balance.breakdown` is real; `credits` and `prepaidCredits` are derived compatibility fields.

### Phase 5 — multiple plans and schedules

- One active plan per `group`; add-ons stack; different groups stack.
- `PlanSchedule` with phases; `createSchedule`, `multiAttach`, `multiUpdate`; default plan on
  cancellation.
- Model gate: `plans.qnt` and `schedules.qnt`; one plan per group, add-on stacking, phase order,
  no activation after cancel.
- Exit: an account can hold a plan plus add-ons and a multi-phase schedule.

### Phase 6 — entities and transfer

- `EntityId` on every operation; entity-scoped plans and balances; pooled items roll up.
- `entities.create/get/list/update`, `billing.transfer`.
- Model gate: `entities.qnt`; entity scope, pooled rollup, transfer conservation.
- Exit: a parent customer can have child entities with their own plans and balances.

## Migration

- Old `Tier` decodes into `Plan`; old `Allowance` into `PlanItem`.
- Old `credits` and `prepaidCredits` decode into balance sources.
- Old `quantities` becomes `purchased`; `occupied` starts at 0.
- Bump the catalog and standing versions; backfill the balance view through the platform's
  generation/backfill path.
- Keep the command bindings for one release as an advanced surface.

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
