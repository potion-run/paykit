# Brief — customer controls

This is the working plan for the customer-controls slice — auto top-up overrides, spend limits and
usage alerts on a customer. It is a brief, not an ADR: the decisions are in
[0038](../adr/0038-customer-controls-are-state.md). Where this brief and the ADR disagree, the ADR
wins.

It expands [ADR 0035](../adr/0035-plans-plan-items-and-balance-sources.md) §6 ("customer-level
controls are state") and the queue item in [NEXT](../NEXT.md). No code, comment, doc or test names
the product this API is modelled after.

## Rules

- **Quint before code.** `controls.qnt` with `controls_test.qnt`, its mutants and its coverage rows
  land before the TypeScript that implements it ([ADR 0034](../adr/0034-one-quint-model-per-protocol.md)).
- **Controls are state.** One command writes one whole object; nothing about a control is catalog
  data and no catalog field is added. The tier's `topUp` stays exactly as
  [ADR 0026](../adr/0026-a-tier-states-its-whole-top-up-line.md) left it.
- **A limit can refuse; an alert cannot.** A limit is a ceiling in money, judged where the tier's
  `moneyCap` is judged. An alert is evidence, appended beside a `UsageRecorded`, and it moves no
  counter.
- **One writer.** `SetBillingControls` targets `AccountId` on the same `Subscription` aggregate, so
  a control write and a spend cannot race.
- **One spelling.** The public field is `billingControls` (`Customer.billingControls` already
  exists); the command, event, state and view use the same word. Nothing gets a second name.

## Status

Design only — this pane writes no `packages/**`, no `specs/**` and no `*.command.ts`. What is
checked here: the shape in `Customer.ts` today, where the ceiling is judged
(`Allowance.verdict.ts`, `Subscription.aggregate.ts`), how the top-up line is read
(`Subscription.state.ts`, `AutoTopUp.policy.ts`), and how a binding and its layer compose
(`Billing/Balances.binding.ts`, `Billing/Balances.layer.ts`).

The gap is one line: `Customer.billingControls` is declared
(`packages/paykit/src/Customer.ts:52`) and exported (`Read.ts:181`, `index.ts:89`), and nothing in
`src/` ever writes it. `CustomerAutoTopUp` and `CustomerSpendLimit` (`Customer.ts:19`, `:29`) are
read shapes nobody produces, and neither is exported from a barrel.

## Target surface

```ts
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Paykit from "@potion.run/paykit";

const messages = Paykit.feature({ id: "messages", name: "Messages" });

const pro = Paykit.plan({
  id: "pro",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  topUp: { threshold: 5_000, cooldown: Duration.hours(1), pack: "credits_100k" },
  grants: [
    Paykit.planItem(messages, {
      included: 2_000,
      overage: "bill",
      unitPrice: { amount: 2, currency: "usd" },
    }),
  ],
});

export const controls = (account: string) =>
  Effect.gen(function* () {
    // the customer read and the one write it owns
    const customers = yield* Paykit.Customers(account);
    const before: Paykit.Customer = yield* customers.get();

    const after: Paykit.Customer = yield* customers.update({
      billingControls: {
        autoTopUp: { enabled: true, threshold: 2_000 },
        spendLimits: [{ featureId: "messages", amount: 5_000 }],
        usageAlerts: [{ featureId: "messages", at: 1_500 }],
      },
    });

    // the same write as the advanced command binding
    const setControls = yield* Paykit.SetBillingControls(account);
    yield* setControls({ billingControls: { autoTopUp: { enabled: false } } });

    // the reads the controls move
    const balances = yield* Paykit.Balances(account);
    const balance: Paykit.Balance = yield* balances.get({ featureId: "messages" });
    balance.spendLimit; // { amount: 5_000, remaining: 5_000 }

    // a spend past the ceiling answers SpendLimitExceeded; the standing stays `good`
    //   { _tag: "SpendLimitExceeded", feature, limit, billed, reserved?, charge }
    const track = yield* Paykit.TrackUsage(account);
    yield* track({ featureId: "messages", value: 100, idempotencyKey: "turn-1" });

    return { before, after };
  });
```

## The shape

```ts
// src/Customer.ts — the written shape. Replaces the two read-only structs there today.
export const CustomerAutoTopUp = Schema.Struct({
  /** Off switches the line off, even when the plan states one. */
  enabled: Schema.Boolean,
  /** Overrides `TopUpTerms.threshold`; absent keeps the plan's threshold. */
  threshold: Schema.optionalKey(TopUpThreshold),
});

export const CustomerSpendLimit = Schema.Struct({
  featureId: Schema.String,
  /** Minor units, in the standing's currency. `0` refuses every billed unit. */
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const CustomerUsageAlert = Schema.Struct({
  featureId: Schema.String,
  /** The feature's period usage count at which it fires. */
  at: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const BillingControls = Schema.Struct({
  autoTopUp: Schema.optionalKey(CustomerAutoTopUp),
  spendLimits: Schema.optionalKey(Schema.Array(CustomerSpendLimit)),
  usageAlerts: Schema.optionalKey(Schema.Array(CustomerUsageAlert)),
});

/** A stable key for a whole object, so a re-send records nothing (`topUpKey`'s shape). */
export const controlsKey = (billingControls: BillingControls | undefined): string => …

/** Sorted and empty-collapsed: one object has one representation. */
export const normalizeBillingControls = (
  billingControls: BillingControls | undefined,
): BillingControls | undefined => …

// src/Subscription/SetBillingControls.command.ts
/** The catalog facts a payload names, so `decide` needs no catalog. */
export const ControlFeature = Schema.Struct({
  /** Whether some plan in the catalog bills this feature postpaid. */
  priced: Schema.Boolean,
});

export class BillingControlsSet extends Domain.Event("BillingControlsSet", {
  /** The whole object; absent means the customer cleared every control. */
  billingControls: Schema.optionalKey(BillingControls),
}) {}

export class SetBillingControls extends Domain.Command("SetBillingControls", {
  target: AccountId,
  input: {
    billingControls: Schema.optionalKey(BillingControls),
    /** Keyed by feature id: one entry per feature the object names. */
    features: Schema.Record(Schema.String, ControlFeature),
  },
  events: [BillingControlsSet],
  rejects: [ControlsFeatureUnknown, ControlsFeatureNotPriced, ControlsDuplicate],
  middleware: [Session, CatalogGuard],
}) {}

// declared in the same file, like `GrantBalance`'s three
export class ControlsFeatureUnknown extends Domain.Rejection("ControlsFeatureUnknown", {
  featureId: Schema.String,
}) {}
export class ControlsFeatureNotPriced extends Domain.Rejection("ControlsFeatureNotPriced", {
  featureId: Schema.String,
}) {}
export class ControlsDuplicate extends Domain.Rejection("ControlsDuplicate", {
  list: Schema.Literals(["spendLimits", "usageAlerts"]),
  featureId: Schema.String,
  /** The threshold two alerts shared; absent for a limit. */
  at: Schema.optionalKey(Schema.Int),
}) {}

// src/Subscription/TrackUsage.command.ts — beside `MoneyCapExceeded`
export class UsageAlertFired extends Domain.Event("UsageAlertFired", {
  feature: Schema.String,
  /** The control's threshold, in the feature's period usage units. */
  at: Schema.Int,
  /** The feature's period usage after the event that fired it. */
  usedAfter: Schema.Int,
  /** The recording event's own time, so a page can say when. */
  firedAt: Schema.DateTimeUtc,
}) {}

export class SpendLimitExceeded extends Domain.Rejection("SpendLimitExceeded", {
  feature: Schema.String,
  /** The customer's ceiling for this feature this period, in minor units. */
  limit: Schema.Int,
  /** What this feature has already billed this period. */
  billed: Schema.Int,
  /** Money open holds have promised to bill, when any are open. */
  reserved: Schema.optionalKey(Schema.Int),
  /** What this event would add. */
  charge: Schema.Int,
}) {}
```

State, on `Subscription.state.ts`:

```ts
// both UnsubscribedState and SubscribedState: a control outlives a standing
billingControls: Schema.optionalKey(BillingControls),
// SubscribedState only: this standing period's fired thresholds, per feature
alertsFired: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.Int))),
```

## Semantics

### `SetBillingControls`, in order

1. **Normalize** — `normalizeBillingControls`: drop empty arrays, drop an object that normalizes to
   nothing, sort `spendLimits` by `featureId` and `usageAlerts` by `(featureId, at)`. Two callers
   that list features in a different order record the same event.
2. **Duplicates** — two limits for one `featureId`, or two alerts for one `(featureId, at)` →
   `ControlsDuplicate`. Two alerts on one feature at different `at` are legal. A duplicate is a
   tagged refusal, not a schema failure, for the reason `CatalogDuplicateFeature` is: it needs
   evidence and a story, and a decode error would sit outside the typed refusal union.
3. **Unknown** — a `featureId` that is not a key of the command's `features` →
   `ControlsFeatureUnknown`.
4. **Not priced** — a `spendLimits` entry whose `features[featureId].priced` is not `true` →
   `ControlsFeatureNotPriced`. An alert needs no price.
5. **No-op** — `controlsKey(normalized)` equal to `controlsKey(state.billingControls)` records
   nothing (`[]`), so a retry with the same object is one fact. This is `SetUsage`'s rule.
6. **Record** — `BillingControlsSet { billingControls }`, absent when the customer cleared it.

What is a schema failure and what is not:

| Failure | Kind | Where |
| --- | --- | --- |
| `amount` or `at` negative, a non-string `featureId`, `autoTopUp` without `enabled` | schema failure (`Schema.check`), never reaches `decide` | `Customer.ts` |
| duplicate limit or duplicate `(featureId, at)` alert | tagged refusal `ControlsDuplicate` | `decide` |
| feature the catalog does not declare | tagged refusal `ControlsFeatureUnknown` | `decide` |
| limit on a feature no plan prices | tagged refusal `ControlsFeatureNotPriced` | `decide` |
| the carried `features` disagree with the deploy | tagged refusal `CatalogMismatch` in the guard | `CatalogGuard` |

`features` rides the command because `decide` is pure. `CatalogGuard` already exists for exactly
this (`Subscribe`, `ChangeTier`, `StartTrial` all carry catalog fields); extend `CatalogCarried` with
`features` and check it **before** the `input.tier === undefined` early return at
`CatalogGuard.ts:88`. `priced` is "some plan in the catalog bills this feature postpaid"
(`pricingOf(allowance) !== null` for some tier's allowance) — a catalog fact a helper in `Catalog.ts`
answers, used by both the binding and the guard.

### Why it works before a subscription

`billingControls` sits on `UnsubscribedState` as well as `SubscribedState`, so a customer can set an
auto top-up override and pre-declare limits before any plan exists. That is why the two refusals are
decided from catalog facts and not from `state.allowances`: a control is customer intent that binds
when a plan grants the feature, so a plan change must never invalidate it. A control naming a
feature the current plan does not grant is stored and inert — no spend, no refusal — and starts
binding on the next plan that grants it. This is a deliberate refinement of the seed's "a feature
the standing does not grant"; the alternative traps every later write behind a downgrade.

Two consequences the implementer must land:

- `standingFrom` (`Subscription/Standing.ts:286`) builds a fresh `SubscribedState` and would drop
  `billingControls`. Carry it from `previous` exactly as it carries `grants` (`:294`) and
  `previous.currency` (`:322`).
- `PlanChanged` and `PeriodClosed` spread the state, so `billingControls` survives them unchanged.

### The effective top-up line

`topUpOf` (`Subscription.state.ts:530`) becomes the **effective** read, and
`topUpThresholdOf` (`:534`) follows it. `AutoTopUp.policy.ts:337` and `RetryTopUp`
(`Subscription.aggregate.ts:1707`) call `topUpOf`, so neither policy needs a new trigger.

```ts
/** The line a spend is judged against: the customer's override over the plan's. */
export const effectiveTopUpOf = (
  terms: TopUpTerms | undefined,
  billingControls: BillingControls | undefined,
): TopUpTerms | null => {
  const control = billingControls?.autoTopUp;
  if (control?.enabled === false) return null;
  const threshold = control?.threshold ?? terms?.threshold;
  if (threshold === undefined) return null;
  return { ...(terms ?? {}), threshold };
};
```

The truth table, which is a unit test and not a Quint action (it has no state):

| Plan line | `autoTopUp` | Effective |
| --- | --- | --- |
| any | `enabled: false` | none — off |
| `{ threshold: 5_000, pack, cooldown }` | absent | the plan's, unchanged |
| `{ threshold: 5_000, pack, cooldown }` | `{ enabled: true, threshold: 2_000 }` | `{ threshold: 2_000, pack, cooldown }` |
| `{ threshold: 5_000 }` | `{ enabled: true }` | the plan's |
| none | `{ enabled: true, threshold: 2_000 }` | `{ threshold: 2_000 }` — the deployment's default pack and cooldown, no retry |
| none | `{ enabled: true }` | none — nothing to read a threshold from, and no refusal |

So a control can bring a line to a tier that never had one, and it buys the deployment's default
pack (ADR 0026 §3) with the deployment's cooldown. A plan change that removes the plan's line under
a threshold-only control leaves no line; under a control that states a threshold, the line continues
on the new plan with the deployment's pack. `pack`, `cooldown` and `retry` are never customer data,
so a customer cannot buy a different product than the plan sells.

### A limit is a ceiling

The verdict gains one fact and one variant. `JudgedFeature` (`Allowance.verdict.ts`) gets
`spendLimit?: number`; `capacityOf` judges it with the same `promised` number the money cap uses
(`moneyOverflowOf`, `:152`), because both are `billed + promised` against a money ceiling:

- **The binding ceiling names the refusal.** If `spendLimit < moneyCap` (or there is no `moneyCap`)
  and the total is past it → `SpendLimitExceeded`. If `moneyCap` is the lower one → `MoneyCapExceeded`,
  unchanged. A tie names the tier's `moneyCap`, so a catalog-only case keeps its old tag.
- **Enforced in** `TrackUsage` and `Hold` — `capacityOf` is called at
  `Subscription.aggregate.ts:949` and `:1283`, and the two `*RefusalOf` functions map the new
  variant through the same split `moneyCapRefusalOf` (`:497`) already computes. Rename that helper
  to serve both tags; its evidence shape is identical with `limit` in place of `cap`.
- **Not enforced in** `SettleHold`. A hold's admission already counted itself and every other open
  hold (`moneyOverflowOf` adds `feature.reserved`), so a settle only moves promised money into
  `billed` and never raises the total; it cannot be the event that breaks the ceiling. `SettleHold`'s
  existing money-cap re-check (`:1412`) is left alone.
- **Not enforced in** `ConsumeCredits` (credits, no feature), `SetQuantity` / `QuantityProration`
  (a purchase, not usage billing), `ResetAllowance`, or any refund path.
- **Forward-binding.** A limit set below the period's `billed` is accepted (no `ControlsBelowBilled`
  refusal): the money is already billed, and the ceiling blocks the next spend until the period
  resets. `Balance.spendLimit.remaining` is `0` in that window. This is the one place the slice does
  not copy `DowngradeBelowSpend` (ADR 0011), and why: a plan term is what the customer bought, and a
  limit is an instruction the customer may give at any time.
- **Alerts are not checked here.** A limit's refusal is a `Capacity` variant, so `check`, `allowed`
  and `decide` keep asking one question.

### Alerts are evidence

- Emitted by `TrackUsage` and `SettleHold`, beside the `UsageRecorded` they already return. Both
  commands declare `events: [UsageRecorded, UsageAlertFired, …]`.
- Due when `at <= usedAfter` and `at` is not in `state.alertsFired[feature]`. One command can fire
  several, in ascending `at`. `Hold` fires none: a reservation is not usage. `ConsumeCredits` fires
  none: it has no feature.
- Identity is `(feature, at)`, not the feature. Lowering a threshold to a value that already fired
  this period does not fire it again; raising it to a new value can fire at the next usage event,
  because that is a different alert.
- **No retroactive fire.** `SetBillingControls` fires nothing: an alert is evidence about a usage
  event, and firing on a set would need the setter's clock and produce an alert with no usage.
- `alertsFired` is cleared by `PeriodClosed` and by `TrialStarted` / `SubscriptionActivated` (a new
  standing opens a fresh period). It is **not** cleared by `PlanItemReset` (a reset window inside
  the period), so an alert is once per standing period and not once per allowance window. That is a
  deliberate default; it is an open question below.
- A refused `TrackUsage` records no usage and therefore no alert. An accepted one records both under
  one command id, so a replay records neither twice.

## Phases

### Phase 0 — the model (no code)

`specs/paykit/controls.qnt`, `controls_test.qnt`, `scripts/spec-coverage.ts`,
`scripts/spec-mutants.ts`, `specs/paykit/README.md`. Exit: `pnpm spec`, `pnpm spec:test`,
`pnpm spec:mutants`, `pnpm spec:coverage` green, and every named check has its mutant.

The model is smaller than the code: two features (one counted, one postpaid-priced), `int` money,
one period, one limit and one alert per feature. It does not model the auto top-up override (a pure
function), credits, or the read model.

| Action | Source | Event |
| --- | --- | --- |
| `setControls` | `SetBillingControls` | `BillingControlsSet` |
| `clearControls` | `SetBillingControls` with an empty object | `BillingControlsSet` (no object) |
| `track` | `TrackUsage` (and a hold's admission) | `UsageRecorded` |
| `fireAlert` | the alert half of `TrackUsage` / `SettleHold` | `UsageAlertFired` |
| `closePeriod` | `ClosePeriod` / `PeriodEnded` | `PeriodClosed`, `UsageReset` |
| `tick` | the platform clock | — |

| Check | Kind | What it says | Mutant that must die |
| --- | --- | --- | --- |
| `limitIsACeiling` | invariant | `billed <= limit` unless `setControls` is what lowered the limit under it (`loweredBelowBill`, assigned on each set so raising the limit clears it); `track` can never do it | `controls-limit-forgets-charge`: `track`'s guard `billed + price * n <= limit` → `billed <= limit` |
| `alertFiresOncePerPeriod` | invariant | the fire-event count equals the size of the fired-threshold set, and both reset at the close | `controls-fire-twice`: drop `and alertAt[f] notin fired[f]` from `fireAlert` |
| `alertOnlyAtOrPastItsThreshold` | invariant | every fired threshold is `<=` the period usage that fired it | `controls-fire-early`: drop `and usage[f] >= alertAt[f]` from `fireAlert` |
| `limitSurvivesAClose` | invariant | `limit` and `hasLimit` equal what they were at the last close | `controls-limit-dropped-on-close`: reset `hasLimit` on `closePeriod` |
| `limitDoesNotMoveStanding` | `run` | a refused track leaves `standing == Good`; only the model's `block`/`unblock` move it | `controls-limit-blocks-standing`: make the refusal set `standing = Blocked` |
| `alertNeverBlocks` | `run` | a track records while an alert is due and unfired | `controls-alert-blocks-track`: add an alert condition to `track`'s guard |
| `noLimitNoRefusal` | `run` | a track past every number records when no limit is set | `controls-no-limit-refuses`: add `and hasLimit[f]` to `track`'s guard |

Three are named runs and not invariants because a disabled action leaves no counter to conserve —
the same split [ADR 0034](../adr/0034-one-quint-model-per-protocol.md) §3 draws for
`cancelRefusesSettleTest`. `pnpm spec:coverage` needs a `controls` row in `SPEC_FILES`, a
`SetBillingControls` row (`["setControls", "clearControls"]`), `controls: ["track", "fireAlert"]` on
`TrackUsage`, `controls: ["track"]` on `SettleHold`, `controls: ["closePeriod"]` on `ClosePeriod` and
`PeriodEnded`, and `controls: ["init", "step", "tick"]` in `MACHINE_ACTIONS`.

### Phase 1 — the write

`Customer.ts` (the shape, `controlsKey`, `normalizeBillingControls`, `customerOf`),
`SetBillingControls.command.ts` (command, event, three refusals, `ControlFeature`),
`Subscription.state.ts` (the two fields, the helpers, `effectiveTopUpOf`, the effective `topUpOf`),
`Subscription.aggregate.ts` (`decide`, `evolve`, `commands`), `Standing.ts` (carry the object),
`CatalogGuard.ts` + `CatalogMismatch.rejection.ts` (the `features` check), `Catalog.ts`
(`pricedInCatalog`).

Exit: a set, a clear, a no-op and all three refusals are stories; the effective line's truth table is
green; `SetBillingControls` is in the generated command sequence.

### Phase 2 — enforcement and reads

`Allowance.verdict.ts` (the fact, the variant, the binding-ceiling rule),
`Subscription.aggregate.ts` (both `capacityOf` call sites, `SpendLimitExceeded`, the alert emission
in `TrackUsage` and `SettleHold`), `Entitlements.view.ts` (`spendLimit` on the row,
`billingControls` on the state, `featuresOf`, `judgedOf`, `BillingControlsSet` and
`UsageAlertFired` handlers), `BillingState.view.ts` (`billingControls`, `alertsFired`),
`Balance.ts` (`Balance.spendLimit`), `Check.ts` (pass the limit into the verdict).

Exit: `check`, `allowed` and `decide` agree on every generated script that includes
`SetBillingControls`; `test/properties/Agreement.test.ts` extends to the new fields.

### Phase 3 — the surface

`Billing/SetBillingControls.binding.ts`, `Billing/Customers.binding.ts`,
`Billing/Customers.layer.ts` (the `BalancesRead`/`BalancesLive` pattern: one `CustomersRead`
service so the in-process and Api layers compose once), `Billing/TrackUsage.binding.ts`,
`Billing/Hold.binding.ts`, `Billing/Check.binding.ts` (the new refusal),
`Billing/BillingInProcess.layer.ts`, `Billing/BillingApi.layer.ts`, `BillingApi.api.ts`
(`commands`), `Billing/index.ts`, `index.ts`, `Paykit.ts`, `Read.ts`, `Atom.ts` (the tenant verb
list is closed; `updateBillingControls` is the write).

Exit: every `Customers` and `SetBillingControls` call in `test/bindings` runs once against each
layer; `Paykit.Customers(account).get()` answers a `Customer` on the Api layer too.

### Phase 4 — proof

The test matrix below, then the gates. Exit: `pnpm test` green, `pnpm spec:mutants` kills all seven.

## The decide table

| Command | Reads | Events | Refusals | Notes |
| --- | --- | --- | --- | --- |
| `SetBillingControls` | `state.billingControls`, `command.features` | `BillingControlsSet` | `ControlsFeatureUnknown`, `ControlsFeatureNotPriced`, `ControlsDuplicate` | works unsubscribed; no-op on an equal object; normalizes before writing |
| `TrackUsage` | + `state.billingControls`, `state.alertsFired` | `UsageRecorded`, `UsageAlertFired…` | + `SpendLimitExceeded` | alerts appended in ascending `at`; a refusal records neither |
| `Hold` | + `state.billingControls` | `UsageReserved` | + `SpendLimitExceeded` | a reservation is money promised; no alert |
| `SettleHold` | + `state.billingControls`, `state.alertsFired` | `UsageRecorded`, `UsageSettled`, `UsageAlertFired…` | unchanged (no limit re-check) | the admission already counted the hold |
| `ClosePeriod` / `PeriodEnded` | — | unchanged | unchanged | evolve clears `alertsFired`; `billingControls` survives |
| `Subscribe` / `StartTrial` | — | unchanged | unchanged | evolve carries `billingControls` from the previous state, starts `alertsFired` empty |
| `ChangeTier` / `PlanChanged` | — | unchanged | unchanged | a plan change never rewrites or prunes a control |

## The read model

| Read | Field | From |
| --- | --- | --- |
| `Balance` | `spendLimit?: { amount: Int, remaining: Int }` | the row's `spendLimit`; `remaining = max(0, amount - billed)`; holds are not subtracted, so `check` stays the authority |
| `BalanceFeature` | `spendLimit?: Int`, `billed?: Int` | `FeatureEntitlement` |
| `FeatureEntitlement` | `spendLimit?: Int` | `BillingControlsSet` (add/remove per feature) and `featuresOf` for a new plan's rows |
| `EntitlementsState` | `billingControls?: BillingControls` | `BillingControlsSet`; needed so a limit set before activation reaches the rows the activation builds |
| `BillingStateView` | `billingControls?: BillingControls` | `BillingControlsSet`; survives activation, change and close |
| `BillingStateView` | `alertsFired?: Array<{ featureId, at, firedAt, usedAfter }>` | `UsageAlertFired`; cleared by `PeriodClosed` and by an activation |
| `Customer` | `billingControls?` | `customerOf(account, BillingStateView)` |

The account-level `EntitlementsState.billingControls` and the row-level `FeatureEntitlement.spendLimit`
are both needed and are not a duplicate fact: `judgedOf` builds a `JudgedFeature` field by field, so
the row must carry the limit for `allowed` to keep using `capacityOf`; and `featuresOf` builds a new
plan's rows from the allowances alone, so the account object is what gives those rows their limit.
`judgedOf` must pass `value.spendLimit` through — leave it out and `allowed` disagrees with `decide`
on the same standing.

`BillingState.topUp` keeps meaning the **plan's** line; `billingControls.autoTopUp` is the override,
so a page reads both and can compose the effective line with `effectiveTopUpOf`. Making the view's
`topUp` effective would need the fold in five handlers and would drift from `topUpOf`; one pure
helper is the single source.

## Test matrix

| File | Proves |
| --- | --- |
| `specs/paykit/controls.qnt`, `controls_test.qnt` | the four invariants and the three runs above |
| `scripts/spec-mutants.ts` | one mutant per check, all killed |
| `test/verdict/AllowanceVerdict.test.ts` | the binding ceiling: limit below cap names the limit, a tie names the cap, no limit leaves `Money` byte-identical, `SettleHold`'s `moneyOverflowOf` path untouched |
| `test/stories/Controls.story.test.ts` | set, clear, no-op, duplicate, unknown, not-priced; a limit refuses `TrackUsage` and `Hold`; a lock past the limit refuses; a limit below the bill is accepted and binds forward; alerts fire once, ordered, at-or-past, and never refuse; a refused track fires none; the top-up truth table |
| `test/properties/Controls.test.ts` | generated: controls never move `standing`; `UsageAlertFired` never moves `remaining`, `billed` or `credits`; with no limit the verdict equals the pre-slice verdict; `controlsKey` collapses order; a plan change never rewrites controls |
| `test/properties/Arbitraries.ts` | `SetBillingControls` in the generated sequence, so replay, idempotence and delivery-order properties cover it |
| `test/properties/Agreement.test.ts` | `Balance.spendLimit`, `FeatureEntitlement.allowed` and `decide` agree |
| `test/properties/Idempotence.test.ts` | the same object twice records once |
| `test/billing/Customers.test.ts` | `get`/`update` round trip, read-your-write, `{}` clears, `CustomerNotFound` |
| `test/bindings/BillingBindings.test.ts` | `Customers` and `SetBillingControls` on both layers; the tenant layer still provides no admin verb |
| `test/check/Postpaid.test.ts` | `check` answers `allowed: false` at the limit and `check({ lock: true })` answers `SpendLimitExceeded` |
| `test/Api.test.ts` | another account is `Forbidden`; a forged `features` map is `CatalogMismatch` |
| `test/standing/Phase.test.ts` | the phase table is unchanged by a limit or an alert |
| `test/PublicSurface.test.ts` | the new exports exist and no alias does |

## Files to touch, in dependency order

| # | File | Change |
| --- | --- | --- |
| 1 | `specs/paykit/controls.qnt` | new model: `setControls`, `clearControls`, `track`, `fireAlert`, `closePeriod`, `tick` |
| 2 | `specs/paykit/controls_test.qnt` | the three runs and the refusal scenarios |
| 3 | `scripts/spec-coverage.ts` | `SPEC_FILES.controls`, the five rows, `MACHINE_ACTIONS.controls` |
| 4 | `scripts/spec-mutants.ts` | seven mutants, named in the table above |
| 5 | `specs/paykit/README.md` | the model section, the inventory row, the mutants count |
| 6 | `packages/paykit/src/Customer.ts` | the written shape, `controlsKey`, `normalizeBillingControls`, `customerOf` |
| 7 | `packages/paykit/src/Catalog.ts` | `pricedInCatalog` |
| 8 | `packages/paykit/src/Subscription/SetBillingControls.command.ts` | command, event, `ControlFeature`, three refusals |
| 9 | `packages/paykit/src/Subscription/TrackUsage.command.ts` | `UsageAlertFired`, `SpendLimitExceeded`, both `rejects`, both `events` |
| 10 | `packages/paykit/src/Subscription/Hold.command.ts` | `SpendLimitExceeded` in `rejects` |
| 11 | `packages/paykit/src/Subscription/SettleHold.command.ts` | `UsageAlertFired` in `events` |
| 12 | `packages/paykit/src/Subscription/Subscription.state.ts` | both fields, the helpers, `effectiveTopUpOf`, effective `topUpOf` |
| 13 | `packages/paykit/src/Subscription/Standing.ts` | `standingFrom` carries `billingControls` |
| 14 | `packages/paykit/src/Subscription/Allowance.verdict.ts` | `spendLimit`, the `Limit` variant, `spendLimitOverflowOf`, the binding-ceiling rule |
| 15 | `packages/paykit/src/Subscription/Subscription.aggregate.ts` | `decide`, `evolve`, `commands`, both refusal mappers, alert emission, `alertsFired` reset |
| 16 | `packages/paykit/src/Subscription/Entitlements.view.ts` | row and state fields, `judgedOf`, `featuresOf`, two handlers |
| 17 | `packages/paykit/src/Subscription/BillingState.view.ts` | `billingControls`, `alertsFired`, four handlers |
| 18 | `packages/paykit/src/Balance.ts` | `Balance.spendLimit`, `BalanceFeature` facts |
| 19 | `packages/paykit/src/Check.ts` | pass `spendLimit` into `capacityOf` |
| 20 | `packages/paykit/src/CatalogMismatch.rejection.ts` | `feature?` beside `tier` |
| 21 | `packages/paykit/src/CatalogGuard.ts` | the `features` check, before the `tier` early return |
| 22 | `packages/paykit/src/Billing/SetBillingControls.binding.ts` | request, result, refusals, verb (`features` built here) |
| 23 | `packages/paykit/src/Billing/Customers.binding.ts` | `Customers`, `CustomerNotFound`, `CustomersRead` |
| 24 | `packages/paykit/src/Billing/Customers.layer.ts` | `CustomersLive`, the `Balances` pattern |
| 25 | `packages/paykit/src/Billing/TrackUsage.binding.ts` | `SpendLimitExceeded` |
| 26 | `packages/paykit/src/Billing/Hold.binding.ts` | `SpendLimitExceeded` |
| 27 | `packages/paykit/src/Billing/Check.binding.ts` | `SpendLimitExceeded` (a lock can hit it) |
| 28 | `packages/paykit/src/Billing/BillingInProcess.layer.ts` | both new layers, merged |
| 29 | `packages/paykit/src/Billing/BillingApi.layer.ts` | the same over `BillingApi.Client` |
| 30 | `packages/paykit/src/BillingApi.api.ts` | `"SetBillingControls"` in `commands` |
| 31 | `packages/paykit/src/Billing/index.ts` | the new bindings, layers and types |
| 32 | `packages/paykit/src/Paykit.ts` | `Customers`, `CustomersLive`, `SetBillingControls` |
| 33 | `packages/paykit/src/index.ts` | the flat exports, the command classes as `<Name>Command` |
| 34 | `packages/paykit/src/Read.ts` | `CustomerUsageAlert`, `controlsKey`, `AlertFiredView` |
| 35 | `packages/paykit/src/Atom.ts` | `customer(account)` query, `updateBillingControls` mutation |
| 36 | the tests in the matrix | stories, properties, bindings, verdict, check, Api |

Steps 6–21 are Phase 1–2; steps 22–35 are Phase 3. Nothing here changes the catalog, an event that
already exists, or a stored shape that this slice does not own.

## Gates

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

## Migration

None. The package is `0.1.0`, unpublished and never deployed, so there is no older
`BillingControls` record to decode and no consumer generation to bump: the views start at generation
0 with the new fields. The only shape that changes is `Customer.ts`'s exported `BillingControls`,
which nothing has ever written, and the catalog does not move — `Tier.topUp` is untouched, and
`topUp` is still the plan's line, with the customer's override stored beside it.

## Open questions

- **Should an operator be able to write a customer's controls?** This slice is tenant-only
  (`Session`). A support flow ("raise this account's limit for a week") would be an `Admin` verb on
  `BillingAdminApi` with a different blast radius, and the repo has not decided whether an operator
  may change a customer's own guardrail.
- **Should a feature's own reset window re-arm its alerts?** A daily allowance inside a monthly
  period fires an alert once a month here, because the identity is per standing period. Re-arming on
  `PlanItemReset` is a different rule (an alert per allowance window) and would change
  `alertsFired`'s reset fold.
- **Does a spend limit cap a seat purchase?** `SetQuantity` and `ChargeQuantityProration` move money
  for a feature but are not usage billing, so this slice leaves them out. A deployment that sells
  seats may expect "never bill me more than $50 for seats this period" to cover the purchase too.
