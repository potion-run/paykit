# Review — customer controls

An adversarial read of the customer-controls slice against [ADR
0038](../adr/0038-customer-controls-are-state.md) and [the brief](./customer-controls.md). Reviewed
at `a535846` (the slice is `2b59a9a`; nothing in `packages/paykit/src` changed after it). Every
claim below was checked in the file, not in the commit message.

All gates are green at this revision: `format:check`, `lint`, `typecheck`, `test` (975 passing),
`spec`, `spec:test` (20 controls scenarios), `spec:mutants` (72 killed), `spec:coverage` (40
commands, 38 modelled), `exports:check`, `validate:publish-packages`.

## Findings

### 1. `bug` — an unsubscribed customer's auto top-up control can buy a pack before any plan exists

`packages/paykit/src/Subscription/Subscription.state.ts:574`

```ts
export const topUpOf = (state: SubscriptionState): TopUpTerms | null =>
  effectiveTopUpOf(state._tag === "Subscribed" ? state.topUp : undefined, state.billingControls);
```

The override is applied on both tags, so an account with no standing but a control has a line:

```text
topUpOf({ _tag: "Unsubscribed", refs: {}, billingControls: { autoTopUp: { enabled: true, threshold: 400 } } })
// { threshold: 400 }
```

`AutoTopUp` reads that line without a subscription check
(`Subscription/AutoTopUp.policy.ts:337`), `crossedThreshold` matches a pre-plan credit spend
recorded by `TrackUsage` from a purchased pack, `packFor` falls back to the deployment's pack, and
`providerFor` falls back to the first provider. `PurchaseCredits` accepts a purchase with no
standing, so the account is invoiced or charged and the credits are recorded. Before this slice
`topUpOf` answered `null` for every unsubscribed state, which is what [ADR
0026](../adr/0026-a-tier-states-its-whole-top-up-line.md) decided: "no standing, no line, no
refill." ADR 0038 §2 only extends a line to *a plan with no line*, not to *no plan*.

**Smallest fix:** return the override only for a standing.

```ts
export const topUpOf = (state: SubscriptionState): TopUpTerms | null =>
  state._tag === "Subscribed" ? effectiveTopUpOf(state.topUp, state.billingControls) : null;
```

Add `topUpOf(initialSubscriptionState with a control)` to the unit test beside the truth table, and
a prepaid-only story asserting no purchase.

### 2. `bug` — a credit-priced feature never fires an alert from `TrackUsage`

`packages/paykit/src/Subscription/Subscription.aggregate.ts:1105`

The credit-priced branch returns its `UsageRecorded` and closes at `:1123`; the only `alertsFor` in
the command is appended at the end of the counted branch (`:1161`). `SetBillingControls` accepts an
alert on a credit-priced feature (the alert check needs only a catalog feature), and `SettleHold`
does emit for one (`:1572`, `creditPriced ? cost : billed`), so `track` is the one path where an
accepted alert silently never fires. The model cannot see it: it has one counted feature.

**Smallest fix:** append `...alertsFor(state, command.feature, usedOf(state, command.feature) + cost, now)`
to the credit branch's event array, using the same `usedAfter` the event records.

### 3. `bug` — `Check`'s lock path folds `SpendLimitExceeded` into `BindingFailed`

`packages/paykit/src/Billing/Check.binding.ts:54`

`Check`'s refusals list is the union of its own failures and the hold it may place
(`HoldExceeded`, `SpendCapExceeded`, `MoneyCapExceeded`), but `SpendLimitExceeded` is missing. A
`check({ lock: true })` whose pre-check allowed and whose `Hold` then meets the ceiling — a
concurrent `TrackUsage` between the read and the hold, or a stale read on a replica — goes through
`toCheckError`, which answers:

```text
{ _tag: "BindingFailed", binding: "Paykit.Check", message: "" }
```

That is a model refusal reported as a transport failure, the one thing the three-failure-kind rule
exists to prevent: a caller may retry it as "unknown outcome". `Hold.binding.ts` and
`TrackUsage.binding.ts` got the tag; `Check.binding.ts` did not.

**Smallest fix:** import `SpendLimitExceeded` and add it to `refusals` in `Check.binding.ts` (two
lines). Then add the lock-past-the-limit case to the test matrix (finding 7).

### 4. `bug` — `BillingReadRow.billingControls` is dropped by the SQL read-model store

`packages/paykit/src/BillingReadStore.ts:30` adds the field; `packages/paykit/src/Store/SqlEventLog.ts:402`
inserts a fixed column list without it, and `packages/paykit/src/Migrations/index.ts:145` has no
`billing_controls` column. `MemoryBillingReadStore` stores the whole row, so `List` returns the
controls on the in-memory platform and `undefined` on SQL. `doctor` and the read-model tests do not
notice, because the field does not change a verdict (`evaluateCheck` reads `feature.spendLimit`, not
`billingControls`). The repo's rule is that the seam holds on every platform.

**Smallest fix:** remove `billingControls` from `BillingReadRow` and `Check.rowToState` — nothing
reads it, and `features.spendLimit` already carries the ceiling per feature. (The alternative is the
column, its `rowToReadModel` mapping and an appended migration record, which buys nothing today.)

### 5. `risk` — `Customers.update` discards the waited write result and re-reads without `atLeast`

`packages/paykit/src/Billing/Customers.layer.ts:88`

```ts
yield* write({ billingControls: request.billingControls });
const view = yield* viewOf(account);
```

`SetBillingControls` already read `BillingState` with `atLeast: receipt` and returned the controls it
saw; `update` throws that away and issues a second, unguarded `BillingState.get`. In-process the
view is monotonic, so this is invisible. Over `BillingApiLayer` with a replica-backed client, the
second read can be older than the write the command binding waited for, which is exactly what "every
verb waits for the read it just wrote" forbids.

**Smallest fix:** have `SetBillingControlsResult` carry the `BillingStateView` it already read (or
the `Customer` built from it), and let `Customers.update` answer with that instead of re-reading.
`Customers.get` keeps the plain read.

### 6. `risk` — the property suite never generates `SetBillingControls`

`packages/paykit/test/properties/Arbitraries.ts:207` — `CommandPlan` is a hand-maintained union and
the new command is absent, so `Agreement`, `Replay`, `Idempotence`, `Delivery` and `Shapes` never see
`BillingControlsSet`, `UsageAlertFired`, `billingControls`, `alertsFired` or the `Limit` verdict. The
per-command loop (AGENTS) says the command joins the generated sequence; the brief's matrix said the
same. This is how the `Check` refusal gap and the credit-branch alert gap stay green.

**Smallest fix:** add a `Schema.TaggedStruct("SetBillingControls", { … })` case with a couple of
deterministic controls payloads and the matching `commandOf` branch, then let the existing property
files run unchanged.

### 7. `risk` — the test matrix is thinner than the brief

`packages/paykit/test/billing/Customers.test.ts` is the only file that mentions a control
(`SpendLimitExceeded`, `alertsFired`, `BillingControlsSet`, `UsageAlertFired` all appear there and
nowhere else). Missing against the brief's matrix:

- no story file at all (`test/stories/Controls.story.test.ts`), so no rejection has a story;
- no `Hold` (or `check({ lock: true })`) past the limit — the second enforcement point is untested,
  and finding 3 is invisible without it;
- no limit lowered below the period's bill in TypeScript (the model has
  `lowerLimitBelowBillTest`, the code path does not);
- no plan change preserving `billingControls`, and no `standingFrom` carrying it across an
  activation (the unit-level proof is only the model);
- no pre-plan limit enforced after activation;
- no alert on a feature with no price, and none on a credit-priced feature (finding 2);
- no inert control: a limit on a feature some *other* plan prices but the current plan does not
  grant;
- no `test/Api.test.ts` case for a forged `features` map (`CatalogMismatch`) or another account
  (`Forbidden`), although the guard works;
- no `test/bindings/BillingBindings.test.ts` / `test/PublicSurface.test.ts` entry.

**Smallest fix:** land the cases in the brief's order, starting with the `Hold` and `lock` ones —
they cover the code paths with no test at all.

### 8. `risk` — `customers.update({})` silently clears every control

`packages/paykit/src/Billing/Customers.binding.ts:16` and
`packages/paykit/src/Billing/SetBillingControls.binding.ts:19` make `billingControls` optional on
the request, so a caller that builds `{}` (or spreads a conditional field) wipes the customer's
controls instead of changing nothing. The command input has to stay optional to spell a clear; the
verb does not.

**Smallest fix:** make `billingControls` required on `CustomerUpdateRequest` and
`SetBillingControlsRequest`, with `{}` as the documented clear.

### 9. `risk` — the new client-error refusals answer HTTP 500

`packages/paykit/src/HttpStatus.ts:27` — `ControlsFeatureUnknown`, `ControlsFeatureNotPriced` and
`ControlsDuplicate` fall to `default: 500`, while their analogues (`PlanNotInCatalog`,
`CatalogMismatch`, `CatalogInvalid`) are 400. A customer naming a feature the deploy does not have
is a bad request, not a server fault. `SpendLimitExceeded` is in the same position as its siblings
`SpendCapExceeded`/`MoneyCapExceeded`, which are also 500; that inconsistency predates the slice.

**Smallest fix:** add the three controls tags to the 400 case, and decide the ceiling tags separately
(pre-existing).

### 10. `risk` — enabling a line over a pool already below it buys nothing

`packages/paykit/src/Subscription/AutoTopUp.policy.ts:312` — `AutoTopUp` reacts to the two spends,
`TopUpCooldownCleared` and `TopUpRetryDue`, and `crossedThreshold` requires the pool to have been
*above* the line before the event. A customer who sets `{ enabled: true, threshold: 5_000 }` while
the pool is 3_000 has created a line that cannot fire until a grant lifts the pool and a later spend
crosses it — "I turned on auto top-up and nothing happened" until the period resets. ADR 0038 §2
says the control brings a line into existence and the brief says no new trigger; that is consistent
but it makes the enabling write a no-op for the case it exists for.

**Smallest fix:** either add `BillingControlsSet` to `on` with the same "the pool is at or below the
line" test the cooldown uses (keyed by the command id, so a redelivery is one purchase), or record
in ADR 0038 that a control is not a crossing and takes effect on the next one.

### 11. `nit` — `controlsKey` depends on the key order of `autoTopUp`

`packages/paykit/src/Customer.ts:119` stringifies the normalized object, and
`normalizeBillingControls` (`:92`) passes `autoTopUp` through untouched. `{ enabled, threshold }` and
`{ threshold, enabled }` key differently:

```text
{"autoTopUp":{"enabled":true,"threshold":5000}}
{"autoTopUp":{"threshold":5000,"enabled":true}}
```

The aggregate decodes the command with its schema, so the public paths currently arrive in schema
order and the test passes; the key is still one re-ordering away from a second event. `topUpKey`
(`Tier.ts:151`) already writes its fields out for this reason.

**Smallest fix:** rebuild `autoTopUp` field by field in `normalizeBillingControls`.

### 12. `nit` — `Customers.get()` answers an empty customer for an unknown account

`packages/paykit/src/Billing/Customers.layer.ts:30` — `customerOf(account, null)` returns
`{ id, plans: [] }`. The brief's matrix expected `CustomerNotFound`, and ADR 0038 §8 says a plan
activation or a controls write is what makes a customer exist. The ADR does not require a refusal, so
this is a surface decision that was made silently rather than a defect.

**Smallest fix:** pick one and say so — add the `CustomerNotFound` refusal, or add a sentence to the
brief/ADR that a read never refuses and an empty customer means "nothing recorded yet".

### 13. `nit` — dead or misleading leftovers

- `billingControlsOf` (`Subscription/Subscription.state.ts:549`) is exported and unused.
- `judgedOf` calls `spendLimitOf(state, feature)` twice (`Subscription/Subscription.aggregate.ts:497`).
- `UnsubscribedState.billingControls`' doc says a limit or alert "is refused until a plan grants one"
  (`Subscription/Subscription.state.ts:276-280`), which contradicts the catalog-fact rule the code
  implements: only an unknown or unpriced feature is refused.
- `Balances` declares `SpendLimitExceeded` (`Billing/Balances.binding.ts:102`) but composes only
  `SetUsage`, `SettleHold` and `ReleaseHold`, none of which can answer it.
- `UsageAlertFired` is dropped by the timeline's default branch (`Timeline.ts:616`), so a console
  reading the timeline never sees the crossing the ADR added the event for.
- `SpendLimitView.remaining` ignores open holds (`Balance.ts:42`); the brief documents that, the
  field doc does not, and it differs from the unit `Balance.remaining`, which excludes held units.

## Where I found nothing

- **The model.** `controls.qnt` carries exactly the actions the brief asked for (`setControls`,
  `clearControls`, `track`, `refuse`, `fireAlert`, `closePeriod`, `tick`), the four invariants and
  the three runs; all five witnesses including `limitSurvivedClose` are reached; every invariant has
  a mutant and all six controls mutants are killed; the three runs exist and pass in
  `controls_test.qnt`. `spec:coverage` classifies `SetBillingControls`, `TrackUsage`, `Hold`,
  `SettleHold`, `ClosePeriod` and `PeriodEnded` correctly.
- **The catalog seam.** `controlFeaturesOf` omits a feature the catalog does not declare and keeps a
  declared-but-unpriced one as `priced: false`; `catalogMismatchOf` checks `features` before the
  `tier` early return, so a controls payload cannot bypass it. Verified directly: a forged `priced`,
  a lie about an unpriced feature and an unknown feature all answer `CatalogMismatch`, and a
  `tier`-less command cannot skip the check.
- **The canonical no-op.** Normalization sorts and collapses, an equal object records nothing (the
  in-process test sends the same command twice and gets one event then none), and a clear records
  `BillingControlsSet` with no object rather than `{}`.
- **ADR compliance otherwise.** The binding ceiling names the refusal and a tie names the plan's
  (`capacityOf` + `AllowanceVerdict.test.ts`); `check`, `allowed` and `decide` share `capacityOf`;
  `Hold` enforces the limit and `SettleHold` does not re-check; an alert is ordered, at-or-past its
  threshold, once per period, and a refused track records none; controls survive `PlanChanged` and
  `PeriodClosed`; `standingFrom` carries `billingControls`.
