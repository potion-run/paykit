# paykit

`@potion.run/paykit` — billing and entitlement for Alchemy. You declare a catalog beside your
stack, the library keeps each account's **standing**, and `check()` answers from local state in
one read.

A subscription is not a payment. A payment is an event that changes a standing. Every rule here
derives from that sentence. [PLAN.md](./PLAN.md) is the design of record and wins wherever this
file is silent: vocabulary, domain model, storage contract, milestones.

**Read PLAN.md before you name anything, add a public export, or change what a command does.**
The non-goals in it are commitments — if a feature needs a compliance officer, it is not in this
package.

This package is one of the `@potion.run` packages. Repo rules — workspace layout, versioning,
Effect discipline, gates — live in [the root AGENTS.md](../../AGENTS.md).

## The two planes

| Plane | Owner | Rule |
| --- | --- | --- |
| Entitlement | us | `check()` answers from one local read: allowed, remaining, `resetsAt`, standing. No provider round trip, ever. |
| Money | the provider | Checkout, cards, tax, invoices, retries sit behind the `Payments` port. |

A provider call never decides an entitlement, and provider vocabulary never reaches the model.
Every "just read it from the provider" is a migration we owe later.

## Vocabulary is API

The public words are `Plan`, `PlanItem`, `Feature`, `Customer`, `Balance`, `Subscription`,
`BillingControls`,
`Period`, `Usage` and `Standing` ([ADR 0035](../../docs/adr/0035-plans-plan-items-and-balance-sources.md)).
`Tier` and `Allowance` are internal schema names while the state migrates; the events speak plan,
and the advanced command bindings keep their `Tier` names for now. They are not a second public
API. A balance is a list of sources, not one number. Before naming a type, a file or
an export, read the vocabulary in PLAN.md and the ADR above — a second spelling of an existing
word is a breaking change.

## Catalog authoring

The catalog is plain data that `BillingStack` validates and records. `Feature`, `Tier` and
`Catalog` are not Alchemy resources: no `Diff` / `Read` / `Reconcile` / `Delete`, no `Type`, no
`FQN`. `BillingStack` is the resource; the catalog is its desired state. The root
[Alchemy API conventions](../../AGENTS.md#alchemy-api-conventions) are the general rule.

```ts
const messages = Paykit.feature({ id: "messages", name: "Messages" });

const free = Paykit.plan({
  id: "free",
  name: "Free",
  grants: [Paykit.planItem(messages, { included: 100 })],
});

const pro = Paykit.plan({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.planItem(messages, { included: 2_000, overage: "bill" })],
});

Paykit.catalog({ features: [messages], tiers: [free, pro] });
```

- `feature()` declares a meter once. `FeatureId` and `TierId` are branded; a tier quotes a
  feature by value through `allowance()`, never by a bare string.
- `tier()` bundles at least one allowance for a subscription. A missing `price` is free; prices
  are integer minor units plus a currency. A `kind: "one_off"` pack is the exception: it grants
  credits, has no allowances, defaults `creditsExpire` to `"never"`, and must state a price. The
  catalog refuses either shape the wrong way round.
- A subscription tier may state `topUp`, the credit line at or below which a spend buys the
  deployment's auto top-up pack. It is carried on the standing, and a pack cannot state one
  (`CatalogTopUpOnPack`) because a pack has no spend to observe.
- A postpaid allowance states `unitPrice: { amount, currency }` or the full `pricing` (`unit`,
  `graduated`, `volume`, with an optional `units` package size) and optionally `moneyCap`; both need
  `overage: "bill"`, and a tier's prices share one currency (the tier price's, when it has one). The
  catalog refuses a price with nothing to bill (`CatalogUnitPriceWithoutBilling`), a money cap with
  no price, and mixed currencies. `check()` prices the requested amount; `Track` records `charge`,
  `billable` and the `priced` lines on the event and refuses past the money cap.
- `catalog()` / `defineCatalog()` validate the graph and refuse with `CatalogError`, a
  `Schema.Union` with one tag per refusal. A new semantic rule gets a new tag carrying its
  evidence and a test; `CatalogInvalid` is only for a schema failure.
- Constructors stay pure; `catalog()` is the only effectful step. Lookups are `planOf`,
  `featureOf` and `planItemsOf`.
- What a tier can express is a decision with a record: [ADR
  0001](../../docs/adr/0001-catalog-states-the-pricing-model.md) says pricing is catalog data and
  the deploy provisions the vendor, so a new shape lands as a field plus a `decide` rule, never as
  a provider id or a runtime edit.
- No provider ids in the catalog. The tier → vendor price mapping lives in provider config;
  `CatalogPriceMismatch` in `Stack` is the backstop.
- A public catalog function carries a JSDoc example, like an Alchemy primitive.
- A command that records money carries the number it recorded (`price` on activation, `priceBefore`
  and `priceAfter` on a change). A catalog whose price moves never rewrites a standing that already
  exists, so the log alone answers "what were we charging".

## Model rules

- `decide` is pure: state and command in, events or a rejection out. No I/O, no clock, no
  provider, no ambient read — and no `Actor`, so authorization is middleware, never a model
  rule that depends on which surface sent a command.
- Time arrives as command data or from the supplied `Clock`. `Date.now()` inside `decide` is a
  bug the properties will find for you.
- Money is `Schema.Int` minor units with a currency on every amount. No floats, no dollars.
- `evolve` copies the outcomes events carry (`remainingAfter`, `periodAfter`); it never
  re-derives a rule that `decide` already decided.
- Counters are a fold of the event log. A number that cannot be reproduced by replaying events
  is a bug, not a cache to invalidate.
- Events are public API: add a field to one, never rename or repurpose it. A projection change is
  a rebuild through `Backfill`/`CatchUp`, not a rewrite.
- A `Track` that would exceed a blocking allowance is refused in the same transaction that would
  have recorded it. Never check-then-write, and dedupe by `dedupeKey` so a retry records once.
- `ChangeTier` ships next-period-only first. Mid-cycle proration is a second pass with its own
  properties in `src/Proration.ts`.
- A hold is an entity with an id, and `reserved` / `reservedCredits` are folds of the open holds,
  never counters a command writes. A hold moves `remaining` and `reserved`, never `usage`.
  `SettleHold` bills what ran and returns the rest in the same command, so the common path is two
  calls and there is no third one to forget. Settling a settled hold records nothing (a replay);
  over-settling is `HoldExceeded`, releasing a settled hold is `HoldSettled`, an id nobody issued
  is `HoldUnknown`, and a hold past `expiresAt` is `HoldExpired` — a release still returns the
  units, because a late release is a cleanup and not a charge. `HoldSweep` schedules `HoldElapsed`
  at `expiresAt`, so a hold nobody settles or releases comes back on its own; the deadline is a
  no-op for a hold that already closed, so the caller's release and the sweep cannot both act. A
  hold on a credit-priced feature reserves `amount × rate` at the rate captured when it was placed,
  so a catalog change mid-flight does not reprice work already priced.
- A period close replaces or expires the plan's balance source and records the expiry. A lifetime
grant is a separate `one_off` source: it survives a close, a plan change and a new activation, and
it is spent last ([ADR 0037](../../docs/adr/0037-a-lifetime-grant-is-a-balance-source.md)). A
consumable subscription plan item may not state `resets: "never"`; a non-consumable seat is the
exception because it never resets. A lifetime credit grant is a one-off item or a standalone
balance. A close that ends the standing (`canceled` or `expired`) opens no further
period, and `EnterGrace` is refused once the standing is terminal.

- A balance is a list of sources ([ADR 0037](../../docs/adr/0037-a-lifetime-grant-is-a-balance-source.md)).
  `Balance.breakdown` reports one plan source per active plan, the rollover and every standalone
  grant. A spend takes from the plan sources in plan-set order, then the rollover, then a grant, and
  an expiring grant before a lifetime one. A grant
  is customer state, not plan data: `GrantBalance` writes `BalanceGranted`, `BalanceExpiry`
  schedules `ExpireGrant` at `expiresAt`, and a close or plan change leaves every grant alone.
  `balances.create` is the binding; a resetting standalone grant is an add-on plan item (Phase 5).
- A seat has a **purchased** quantity and an **occupied** count
  ([ADR 0036](../../docs/adr/0036-a-seat-is-purchased-and-occupied.md)). `remaining` is
  `purchased - occupied` and may be negative. `SetQuantity` sets the purchase and may drop below
  occupancy; `SetUsage` sets occupancy; `cap` is a purchase ceiling. A plan change keeps the
  purchase (raising it to a larger free grant) even when the new cap is lower, and never removes an
  occupied seat. `TrackUsage` and `Hold` still refuse a non-consumable feature.
- Dunning retries are opt-in (`Paykit.dunning({ retries })`), and each rung is a scheduled
  `DunningRetry` command, not a timer. The first failure of a run records `dunningStartedAt` on the
  standing; the command records `DunningRetryDue` only while the standing is still in grace, the
  attempt matches and that run still owns the ladder. The policy charges the saved method through
  `Payments.charge` keyed by the run and attempt, records `RecordPayment` or
  `RecordPaymentFailure`, and leaves `GraceElapsed` as the one hard stop. A provider without
  `charge` is `ProviderCapabilityMissing`, never a silent no-op.
- **The standing holds a plan set, not one plan.** `SubscribedState.plans` is a row per active plan,
  keyed by plan id, with the group it fills, its add-on flag and the terms a boundary needs
  (`allowances`, the pool grant, the expiry rule, `topUp`, rate cards, cadence, currency, price).
  At most one row per group is a base plan; a plan with `addOn` stacks beside every group and fills
  no slot. A move writes one row (`withPlan` replaces its group's base plan) and never the whole
  set; `state.tier`, `state.allowances` and `state.pendingTier` are gone — read `planIdOf`,
  `allowancesOf`, `ratesOf`, `currencyOf`, `intervalOf`, `priceOf`, `planRowsOf`, `addOnsOf` and
  `pendingPlanOf`. `check` and the spend path read the merged allowances, so an add-on's feature is
  spendable beside the plan's; two plans that grant the same feature add their `included` counts
  until the ledger reports one source per plan (ADR 0039).
- **A schedule is a list of phases, not one pending change.** `SubscribedState.schedule` is ordered
  by instant and every phase names its group, its add-on flag and the plan a boundary moves to.
  `ScheduleTierChange` appends (`PlanChangeScheduled` carries `at`, the boundary when the caller
  states none) and refuses a phase that is not future (`PlanPhaseNotFuture`) or that names an
  add-on (`PlanPhaseNamesAddOn`). The close applies every phase due at the boundary, in order,
  before the counters reset, so the next period starts on the plan it lands on. `WithdrawTierChange`
  drops the next phase and refuses (`NoTierChangeScheduled`) when none is scheduled. A move drops
  every phase naming the plan it writes and every phase its group had waiting; a terminal standing
  drops them with the cancellation. A phase the held generation has outrun is never due, and the
  close prunes it. At the boundary the old plan's balance source is expired and
  the new plan's source is granted; the expiry is recorded, so the pool's fold is complete. A
  lifetime source is untouched and a pack stays protected. The new plan grant is for the period
  starting here and expires at the next close. It also starts every counter over — a counter
  belongs to the plan item it was recorded on, not to the one the account is entering.
- A trial opens on the cadence its price states: an annual trial converts into an annual period,
  not a monthly one. Its deadline is the first period's end, so it only moves forward:
  `StartTrial` refuses one that is not after `now` and `ExtendTrial` one that is not after the
  deadline already in force (`TrialDeadlineNotLater`). A deadline behind the start would open a
  period the next tick closes.
- Postpaid money is on the event. `UsageRecorded.charge` is this event's bill and `billedAfter` is
  the feature's period total, so a replay reproduces the bill and a catalog price change never
  reprices history. A money cap refuses in the same transaction as the usage and leaves the standing
  `good`.
- **A split draw is one money request** ([ADR
  0051](../../docs/adr/0051-a-pooled-draw-has-one-money-ceiling.md)). A scope spends its own source
  first and the pool for the rest, and each part keeps its unit, count and pricing terms, but the
  event carries one `charge`. `billed + ownCharge + poolCharge` is judged once against the lowest
  `moneyCap` among the sources the request draws; a source it does not draw contributes no cap, and
  the customer's `spendLimit` is one limit on the combined charge. The lower ceiling names the
  refusal and a tie is `MoneyCapExceeded` (ADR 0038). An entity's feature row carries the lower of
  its own cap and the customer's pooled cap so a scoped `check` is conservative; the read cannot
  reproduce a future split exactly, so the write path is authoritative.
- A one-off pack is a purchase, not a tier change: its credits arrive through `PurchaseCredits` /
  `CreditsPurchased`, never `PlanChanged`, and never create a second standing. The standing tracks
  `prepaidCredits` — the part of `credits` a pack bought — so a period close expires only
  `credits - prepaidCredits`, and spending drains the plan's credits before the protected pool.
- An auto top-up is a policy over a crossing, not a timer. `Paykit.autoTopUp({ catalog, pack,
  cooldown? })` provides `AutoTopUp`, which buys the named `kind: "one_off"` pack when a spend takes
  the pool from above the standing tier's `topUp` line to at or below it. The line is catalog data
  (`Tier.topUp`) carried on the plan row, because a free tier and an enterprise
  tier need different lines and `decide` never sees the catalog. A tier without it never refills.
  The balance before the event is derived from the event (`creditsAfter + cost`, `balanceAfter +
  amount`), so a second spend below the line is not a second crossing, and a grant, an expiry or a
  hold reservation never triggers one. It charges the account's saved method when the provider
  declares `charge`, falls back to an invoice when it does not, and records `PurchaseCredits` with
  that `chargeId` or `invoiceId`, so the money and the credits are one record. A provider with
  neither capability is `ProviderCapabilityMissing`, never a free pack. With a `cooldown`, the
  purchase carries `cooldownUntil`, a crossing inside it is deferred rather than dropped, and
  `TopUpCooldownElapsed` clears the standing at the deadline so the policy re-asks.
- Prices are logged. `SubscriptionActivated` carries `price`, `PlanChanged` carries
  `priceBefore`/`priceAfter`, and a downgrade to a free tier records the absence of a price.
  A catalog price change never rewrites a standing that already exists.
- **A plan is versioned, and a move is its migration** ([ADR
  0047](../../docs/adr/0047-a-plan-is-versioned-and-a-move-is-its-migration.md)). `Plan.version`
  is the catalog generation a new move buys; `PlanRow.version`, `CustomerPlan.version` and every
  activation / change event keep the generation that was sold. A move to the same plan id at the
  same version is a replay; a different version is an ordinary move, classified by price like any
  other. A move to a newer generation drops every pending phase that names that plan, and a phase
  older than the row it would write is stale: `ApplyPlanPhase` and the close never apply it.
  `Verify` reports an outdated row, a row ahead of the deploy and a fixed plan whose terms changed
  without a bump, for the customer and for every entity scope. A deploy never rewrites a standing
  and there is no automatic migration.

- Every command has one typed rejection per way it can refuse.

- Customer controls are state, not catalog ([ADR 0038](../../docs/adr/0038-customer-controls-are-state.md)).
  `BillingControls` is written whole by `SetBillingControls`, lives on both state tags so it
  works before a plan exists, and survives a plan change and a close. A spend limit is a `Capacity`
  variant beside `moneyCap`: the binding ceiling names the refusal, and `check`, `allowed` and
  `decide` share it. An alert records `UsageAlertFired` beside the usage fact and moves no counter.
  The write is normalized and compared by `controlsKey`, so an equal object records nothing. The
  catalog facts a write names ride the command as `features` and `CatalogGuard` checks them; a
  control that names a feature the current plan does not grant is stored and inert, because the
  whole object is replaced on each write and a downgrade must not poison a later write.

## The per-command loop

Adding or changing a command touches the same set of files under `src/`, in this order:

1. **Rejections** — `<Rejection>.rejection.ts` per new refusal, carrying what an operator needs
   to explain it.
2. **Command** — `<Command>.command.ts`: payload schema, and the fields a handler must not invent.
3. **`decide`** — the guard, the events it emits, and the numbers those events carry forward.
4. **`evolve`** — copy the event's outcome into state, unchanged.
5. **Views** — `Entitlements` / `BillingState` fold the event if it moves a number a user sees.
6. **Story** — happy path and every rejection, one `Story` each.
7. **Property** — include the command in the generated sequence, so replay, idempotence and
   delivery-order properties cover it.

Done when `Domain.verify(Model)` returns empty, the stories are green, and the properties are
green against generated sequences that include the new command.

`Subscription/StandingPhase.ts` is the read-side phase. `standingPhaseOf` names the tag and the
deadline that will move it, with `overdue` for the window between the clock and the scheduled
command; `standingConditionsOf` names the orthogonal state (trial latch, scheduled cancellation,
pending tier, cooldown, holds, proration, unplanned credits). `STANDING_PHASE_TRANSITIONS` is a
total table — every phase answers every move, with an impossible move as a self-edge — in the shape
of Alchemy's `SQLITE_TRANSITIONS`. `STANDING_PHASE_EDGES` is the annotated view of the same table.
`test/standing/Phase.test.ts` walks `decide` against it: a command that moves a standing somewhere
the table does not name fails there, so a new edge is an edit to one table, not a silent widening of
the lifecycle. The hold's `HOLD_STATUS_TRANSITIONS` and the webhook edge's `WEBHOOK_TRANSITIONS`
use the same total-table shape: a closed hold is absorbing, and an event that records nothing is
`ignored` rather than a missing branch.

## Surfaces

The recommended runtime surface is plan operations, not one verb per command: `billing.attach`,
`billing.update`, the two previews, `check`, `track` and `balances` ([ADR
0035](../../docs/adr/0035-plans-plan-items-and-balance-sources.md)). The command bindings in the
`Billing` barrel are the advanced surface. A public operation folds the money step in; a caller
must not have to call a second verb to collect a proration.

A customer exists before it buys: `Paykit.Customers(account).create` records the identity a billing
page shows, `getOrCreate` is the idempotent sign-up path, and `CustomerCreated` is a latch no
billing decision reads (`CreateCustomer`, ADR 0045).

Tenant and admin are two `Api`s over one model, with different middleware and different blast
radius. `Foldkit.make(BillingAdminApi)` derives the console — do not hand-write command plumbing
around it.

- Both surfaces go through the same `Command` with a `commandId` and typed `reply`. `Unknown`
  means exactly "retry with the same id", so a double click cannot double-credit.
- `AdminConsoleRpcs` is the console's own surface — cross-account reads, the tier-change quote and
  the refund — because neither Api can serve a cross-account list or take money out. A refund runs
  the in-process binding, so `AdminConsoleServer` requires `Paykit.Refund` and the Worker that
  serves it must be the one that holds the provider.
- A view folds one key's events. Cross-account lists and metrics come from the `BillingRead`
  projection through `Paykit.List`, never from a view. `after` is a cursor, not an offset.
- A usage timeline is a fold over `AccountEvents`, never a second log. `timelineOf` /
  `appendTimeline` in `Timeline.ts` turn the stream entries into ordered entries and a per-period,
  per-feature rollup; a consumer that holds the events derives it, `lastSeq` makes a redelivery a
  no-op, and nothing in `decide` or `check` reads it.
- An admin action is a command, not a state write. No back doors, no direct row edits.
- `@potion.run/paykit/Surfaces` is the only place MCP and CLI live, and it derives both from
  the two Apis: `DomainAi.toMcp`, `DomainAi.toToolkit`, `DomainCli.toCli`. Never hand-write a
  tool list or a subcommand. It is a separate entry point so HTTP-only apps never load
  `effect/ai` or `effect/cli`.
- A tool is a projection of an Api: one per command and per non-stream read, named
  `<Api>_<Name>_<operation>`, `Destructive` for a command and `Readonly` for a read, with a
  rejection returned as a tool failure. `watch` and `events` are streams, not tools.
- The Api is the unit of authorization. `toMcp` runs each tool call through the Api's own
  middleware using the MCP request's headers, so serving the two Apis at two paths is the whole
  security model. Never merge them.
- `Paykit.Preview` runs the same pure `decide` and reports the events and proration a command
  would produce. Show the charge before applying it; a write an agent may retry carries a
  `commandId`.
- Outbound events are a policy over a port. `OutboundEvents` signs every committed subscription
  event and hands it to the `Outbound` transport; the idempotency key is `<account>:<seq>`. A
  deployment without an `Outbound` layer pays nothing for it, and the app owns HTTP, queues and
  retries at the edge.

### Bindings

The runtime surface is a `Binding.Service` per command, shaped like Alchemy's: `Paykit.TrackUsage(account)`
returns the verb, and the verb takes the rest. [ADR 0015](../../docs/adr/0015-a-runtime-binding-names-a-command.md)
is the record; these are the rules a new one follows.

- **Named for the command.** `TrackUsage`, `SettleHold`, `ChangeTier` — the same string as the command,
  the MCP tool and the CLI subcommand. No alias layer, no `use()`, no `for(account)` handle.
- **The account is the bind; the request is the rest.** The bound id is struck from the request type,
  like `RetrievePriceRequest` omitting `price`, so a second account is not representable. Configuration
  — catalog, store, providers, credentials — rides the layer, never a verb argument.
- **One file per binding** under `src/Billing/<Command>.binding.ts`: the request, the result, the
  refusal list (one list yielding both `type Refusal = InstanceType<(typeof refusals)[number]>` and the
  guard), the error union, `Binding.Service`, and a JSDoc block with `###` operations, an
  `**Example:**` per intent, and `@binding @product … @provides …` last.
- **A binding is a command binding or an operation binding.** A command binding builds its request
  from the caller's fields plus the catalog, so both layers serve it. An operation binding needs
  something only the model's process has — a standing to compute a proration from, a provider, a
  signature — so it has an in-process layer only and the Api does not serve it. `ChangeTier` is the
  case to remember: a mid-cycle upgrade has a proration, a client has no standing, and a payload
  without one is `ProrationMismatch`. Do not paper over that with a call that only works locally.
- **An operation layer delegates; it does not re-implement.** `Subscribe` and `Preview` wrap the
  binding that already walks the provider path (`subscribeOf()`, `previewOf()`), so there is one
  purchase path and one quote. A second implementation is a second answer to "what did we charge".
- **Four layers, one clearance each.** `BillingInProcess` closes over the model; `BillingApiLayer`
  closes over `BillingApi.Client` and `BillingCommands` and is protocol-agnostic, so the deployment
  picks `layerClientInProcess` or `layerClientHttp(url)` and provides the matching command client. `BillingAdminInProcess` and `BillingAdminApiLayer`
  are the operator pair over `BillingAdminApi`. Both tenants implement every tenant verb, so a caller
  cannot tell which one it got; the admin verbs exist only on the admin layers, and the layer a
  deployment provides is the authorization. `test/bindings/AdminBindings.test.ts` asserts the
  negative — a tenant layer provides none of the seven — so a widened layer fails a test.
- **Every verb waits for the read it just wrote.** Read-your-write is a property of the binding, not
  of `TrackUsage`: after the command, `Entitlements` is read with `atLeast` the receipt. A verb that
  skips it hands the next `Check` a stale number. `Webhook` is the one exception and says so in its
  doc: it has no receipt of its own, and a provider wants an answer, not a snapshot.
- **A write requires a `dedupeKey`, and it is the command id.** A transport may redeliver, so the
  key is required rather than optional; a hold's id defaults to it, so a retry addresses the same
  entity. The exception is an operation whose identity is the provider's — `Subscribe` derives
  `checkout:<account>:<tier>:<reference>` — and the binding's doc says so instead of accepting a key
  it would ignore.
- **Three failure kinds, never folded.** A rejection is the model refusing (the write did not
  happen), `Domain.ConsistencyTimeout` is the write committed and the read late, `BindingFailed` is
  the transport or the decode. Only the first may be read as "no charge".
- **A command's own numbers travel as its `reply`.** `SettleHold` answers `{ billed, released }` from
  the event it committed, because the Api client returns no events. A verb whose result is "what is
  left" reads the view instead; a verb whose result is "what this command recorded" needs a reply.
- Every test body runs against both layers, once — `test/bindings` proves the transport is an
  implementation detail, not a second API.

### Atom client

`src/Atom.ts`, entry `@potion.run/paykit/Atom`, is the first-class Effect Atom integration. It wraps
`BillingApiLayer`; it never re-implements a verb.

- `make({ layer })` builds one `Atom.runtime` over `BillingApi.Client` and `BillingCommands`.
  `provideMerge` keeps both on the runtime, so an application query can reach the client without
  rebuilding the transport. The `{ url }` form builds both clients and reads no catalog.
- `entitlements(account)` and `billing(account)` are queries, memoized per account and wrapped in
  `Atom.withServerValueInitial`. Every command atom is memoized per account and invalidates
  `paykit/account/<id>` on success, so a view refreshes without the caller wiring a subscription.
- It exposes the tenant bindings only. `Subscribe`, `ChangeTier`, `Preview`, `Portal` and
  `ChargeProration` are operation bindings: a browser has no provider or standing, so a purchase
  stays a deployment operation (the TanStack example's `/bootstrap`).
- Reads brand the account id once through `Subscription.ref`; `BindingCall` supplies headers when
  the deployment needs them, and a same-origin client relies on its cookie.
- `check` is a command atom because the amount is part of the question; the `entitlements` view
  already carries `allowed` per feature when no amount is involved.

## Auth

`Session` and `Admin` are the two `RpcMiddleware` services in `src/Auth/`. A command declares the
weakest guard it needs; the Api's composition of commands is the blast radius.

- `Session` resolves the `Actor` and pins an `account` actor to its own account id; an `admin`
  or the `system` actor may act on any account. Both views declare it and re-check the key in
  `validate`, so a read is scoped even if a route forgot to be.
- `Admin` requires `kind === "admin"`. `GrantCredits`, `ExtendTrial`, `EnterGrace`, `Recover`,
  `Expire` and the payment commands declare it, so a tenant session cannot reach them.
- In-process senders — `Webhooks`, `Track`, `Hold`, `Subscribe` — provide the actor with
  `asSystem`. The deployment already authenticated the work; a send without a guard is for
  `PeriodEnded`, `GraceElapsed`, `DunningRetry`, `ClosePeriod` and `AttachProviderRef` only.
- `InsecureSessionFromHeaders` and `InsecureAdminFromHeaders` read `x-paykit-actor` and
  `x-paykit-kind`. The name is the warning: any caller can name itself. They are development guards
  over `SessionFrom(resolve)` / `AdminFrom(resolve)`, the provider-neutral entry point: a resolver
  answers `ActorValue | null` from a request's headers and `GuardsFrom` builds both guards over it.
  `null` is anonymous; a resolver failure is a defect, never a refusal, because a broken session
  store must not sign a valid caller out. Production provides a resolver over its own session —
  Better Auth, yielded/auth, a cookie, a bearer token — as `examples/auth` and `examples/admin`
  do, and the header never becomes an authentication scheme by accident.
- `authenticate(resolve)` resolves the same actor for a route that is not an Api, so a checkout or
  a page does not grow a second identity mapping. `Forbidden.scope` names the boundary a refusal
  crossed: `account` for a target the caller may not act on, `admin` for the operator surface.
- A new command without a guard is a review failure unless it is a system fact. Say why in the
  command's JSDoc.
- `CatalogGuard` sits on the three commands that carry catalog-derived fields (`Subscribe`,
  `ChangeTier`, `StartTrial`). `decide` is pure and cannot look a price up, so the command carries
  it — and the guard refuses a payload whose `tier`, `allowances` or `price` disagrees with the
  catalog the deployment validated. Never make the guard "correct" a payload: a client bug must not
  become a wrong invoice.

## Storage

`Paykit.Postgres` and friends are a `Domain.Platform`, not a schema: model, views, policies and
sagas are identical on Postgres, SQLite/D1 and `Domain.InMemory`. `Domain.InMemory` stays green
as the others land — it is the proof the seam holds.

Every store takes the **asynchronous** executor and wraps a multi-row write in `sql.atomic`: a
view's snapshot, entries and input rows; a projection's cursor and processed rows; a stream's
entries and meta. Nothing writes two rows outside a unit and nothing reads synchronously. The schema
a hosted database applies is generated — `scripts/schema.ts` renders `migrationFiles` — so the file
a release runs and the DDL a test runs come from one source; regenerate it rather than editing it.

A store keeps all five `AggregateStore` guarantees or it is not a store: one writer per account
id, dedupe by `commandId`, atomic commit of events + state + receipt + deliveries, at-least-once
delivery in order, `schedule`/`tail` by notify or poll. [PLAN.md](./PLAN.md#storage) gives each
database's mechanism.

Two table classes, no more: `billing_event` (append-only, the only truth) and `billing_rm_*`
(rebuildable at any moment). A read model that becomes a source of truth is a bug.

- Every table is `billing_`-prefixed, the schema is configurable, `public` is never touched.
- Migrations are additive, forward-only SQL records applied through
  `@alchemy.run/sql/Migrations` — the same registry Alchemy uses. The registry owns the
  bookkeeping table (`billing_schema_version`), is name-keyed with content hashes, and refuses a
  rewritten or removed applied file. `migrate()` returns the ids it applied; a replay returns
  none. `migrateDryRun()` prints the DDL before anyone runs it against a money table.
- Postgres DDL qualifies every table with the configured schema; SQLite has no schemas. The
  migration executor sets `search_path` for the registry's unqualified bookkeeping queries and
  restores it afterwards, so it must be a dedicated session, not a pool that spreads statements.
- `paykit doctor` rebuilds every read model into temp tables and prints the event ids that
  disagree. A store ships when `doctor` is clean.
- A consumer's `Domain` version is its generation. `SqlPlatform.start` backfills every view and
  projection that is new or whose generation changed, in source order, and records the generation
  and plan in `billing_rm_backfill`; a view keyed by its one aggregate fills each key on first
  touch through `ViewKit.catchUp`. `SqlViewStore`/`SqlProjectionStore` reset a key built by an
  earlier generation and drop deliveries routed to it (absent generation is 0, so a pre-bump
  delivery is stale). Bumping a consumer's version is the rebuild; never edit `billing_event` to
  make a consumer agree with it.
- A view's downstream deliveries are staged in `billing_rm_view_outbox` in the same unit that
  writes its entries. The upstream outbox retries the *input* delivery, which no longer re-applies
  once deduped, so the output row is what makes a crash between the fold and its target replay
  instead of drop. A read drains it too, so a key nobody writes to again is not stuck.
- `SqlAggregateStore` is the only thing that writes the log, and each of the five guarantees has
  one place in it. Do not add a path that writes `billing_event` without its state, receipt and
  deliveries in the same transaction, and do not deliver before the commit: the outbox row is what
  makes a crash replay instead of drop.
- Code or a test copied from Alchemy keeps a header with the upstream path and the
  catalog-pinned ref. Keep the copied shape 1:1 where it is a compatibility check; the mirrors
  under `.agent_sources/` and the catalog bump then make the next change a diff.

## Providers are ports

`Payments` is the only door to money, and no provider owns its shape. `Memory`, `Manual`,
`Stripe` and `Polar` pass one conformance suite — parameterized by declared capabilities
(`checkout`, `invoice`, `charge`, `refund`, `portal`, `usage`, `quantity`, `setup`) — and
that suite, not a vendor's docs, defines the port. `Manual` (invoice payable by transfer) is the
reference: if the port only fits Stripe, it is not a port.

Processors (Stripe) move money; merchants of record (Polar) also own tax, receipts and the
customer portal. The port is what they share, and a provider declares the rest. The model never
imports a provider — the adapter is wired by the user, behind the port.

A deployment can run several providers: `paymentsRouter(Primary(), Secondary())` holds them by name,
and `Subscribe`, `ChargeProration`, `Portal` and `SetupPayment` each resolve *one* for the call — the
provider the account's `refs` already name, else the first in the list — and provide only that
provider's built context. `paymentsRouter` builds each provider's layer once, when the world builds,
so a command provides services rather than rebuilding a layer; merging provider layers instead would
leave one `Payments` in context and the other shadowed. `Stack` refuses two providers that share a
name, because `refs` is keyed by it.

```ts
const world = Layer.mergeAll(
  Paykit.Model.layer(Paykit.ModelHandlers),
  Paykit.paymentsRouter(Paykit.Stripe({ ... }), Paykit.Polar({ ... })),
);
```

- **The catalog carries no provider ids.** Tier → price mapping lives in the provider config,
  so the same catalog runs on every provider.
- **Vendor ids live in `refs`**, keyed by provider. Nothing else in the model learns `cus_…`.
- **The provider's entitlement view is a projection of ours.** Polar benefits and Stripe
  entitlements are written after a tier change; `check()` never reads them back.
- **The price has one meaning.** The catalog states it, the vendor package charges it, and
  `Stack` fails with `CatalogPriceMismatch` when the mapping disagrees.
- **Webhooks translate at the edge**, into our events, with the provider's event id as the
  `commandId` so a redelivery is a replay, not a second charge. `Webhook()` is that edge as a
  binding — the model's services resolved once, an event applied per delivery — so a route builds
  it beside its other bindings instead of re-resolving the model on every call. A hosted purchase
  carries its quote keyed by the vendor reference (`PendingQuote`), so concurrent checkouts keep
  their own terms and a completion that names none while several are held is
  `PendingActivationAmbiguous` (ADR 0044).
- **A refund is a fact about money, capped by the log.** `Refund` records `RefundRecorded`
  (`chargeId`, `refundId`, `amount`, `currency`, `refundedAfter`, `commandId`), and the ceiling is
  what the log recorded as charged per currency — `PaymentRecorded`, `CreditsPurchased.price`,
  `ProrationInvoiced` — less what went back: `RefundExceedsCharged`, never a negative payment. It is
  an operator command (`Admin`), the provider call happens in the `Paykit.Refund` binding before the
  command and is keyed by the operator's `dedupeKey`, and a refund never touches the credit pool
  because revoking credits is `ConsumeCredits`
  ([ADR 0019](../../docs/adr/0019-a-refund-names-the-charge-it-reverses.md)).
- **A missing capability is a typed error**, `ProviderCapabilityMissing`, naming provider and
  op. The console hides the action; nothing degrades silently.
- **The provider carries its own webhook.** Given a signing secret, `Stripe()` and `Polar()` return
  a provider whose `webhook.decode` is the vendor's decoder with the tier mapping already bound, so
  a deployment writes the secret and the mapping once. `ProviderDescriptor.webhook` records whether
  a stack can hear a payment at all.

 The provider a vendor package returns is `MoneyProvider`, not `Provider`: Alchemy owns that word
for the service that reconciles a resource (`alchemy/Provider`), and `BillingStack.resource.ts`
imports both. A `MoneyProvider` is a value — name, kind, capabilities, the `Payments` layer, prices
and the webhook decoder — never a lifecycle.

A **vendor package** owns the vendor's plumbing: `@potion.run/paykit-stripe` for Stripe and
`@potion.run/paykit-polar` for Polar, both ours, each in its own package
([stripe](../paykit-stripe/AGENTS.md), [polar](../paykit-polar/AGENTS.md)), published separately.
Each exposes one call that returns the `Provider` the catalog needs, a `Client` interface a test
stands in for, and the webhook decoder — built on the vendor's distilled SDK. The `Payments<V>`
adapter delegates to them: if an op is missing, add it to the vendor package, not to the adapter.

Both are **paykit packages**, not general Alchemy providers: they import `@potion.run/paykit` and
export the shortest path from a catalog to a working provider. That is a maintenance decision, not a
coupling accident — a general provider would need its own users, docs and release train, and we
would carry all of it to serve one adapter. If someone needs Stripe or Polar without paykit,
`@alchemy.run/stripe` exists for exactly that. A test, or a caller with its own vendor bindings,
still uses the adapters directly: `PaymentsStripe({ bindings, tiers })` and
`PaymentsPolar({ bindings, tiers })` are the port mappings the packages fill in.

A vendor package also owns the deploy half: `StripePrices` and `PolarPrices` create the prices, or
the products with their embedded prices, that the catalog states — and for each postpaid feature, a
meter and a metered price from the same `pricing`: one rate, a package transform, or a graduated /
volume ladder. A provider that can hold the full shape declares it as `usagePrices`; the one-rate
`unitPrices` map remains the shorthand. They return the meter event names and the
metered handles the runtime provider needs, so `PeriodCloseUsage` can push the closing period's
billable units. Both declare every resource with `RemovalPolicy.retain`, so a tier that leaves the
catalog leaves a financial record rather than a deleted one. They are deploy-time helpers, not
resources paykit reconciles; `BillingStack` records what they produced.

Adding a provider touches the same places every time:

1. **The vendor package** — `@potion.run/paykit-<vendor>` when no Alchemy provider fits what paykit
   needs (`paykit-stripe`, `paykit-polar`), or `@alchemy.run/<vendor>` bindings mapped by
   `Payments<V>.ts` when one does. Either way: a client interface, a distilled-backed client, and a
   single call that returns the `Provider` the catalog needs.
2. **The adapter** — `Payments<V>.ts`: delegate to those bindings; required ops, plus the
   optional ops it declares.
3. **The translation** — its webhooks into our commands, provider event id as `commandId`.
   `polarWebhook` and `stripeWebhook` are the references: signature, payload, then a tier from the
   mapping, with nothing guessed.
4. **The config** — its products in the provider config; the catalog does not move.
5. **The suite** — its conformance run, green alongside `Manual`'s, and an end-to-end story that
   signs a webhook and reads the answer back out of `check()`.

Done when `Manual` and the new provider pass the same cases and no `Subscription/*` file changed.

## Money outlives the stack

:::warning
The ledger is application data, not stack state. `RemovalPolicy.RETAIN` on catalog and account
resources, and nothing in a delete path cancels, refunds or deletes provider state. A `destroy`
that cancels a live subscription is a support incident.
:::

The README says this next to the quickstart.

## Public surface

Four export groups and nothing else: deploy-time resources, runtime bindings, model, providers.
`src/index.ts` re-exports those four. If a user can import it, it is API — everything else stays
internal, whatever it is.

- Opt-in integrations are an optional peer plus a dev dependency, so a user who never imports
  `@potion.run/paykit-polar` never installs it.
- Model files under `src/` are `<Noun>.<kind>.ts` (`.aggregate`, `.command`, `.rejection`,
  `.view`, `.stream`, `.projection`, `.saga`); runtime files use Alchemy's resource/binding
  pairing. Plain values keep plain names (`Feature.ts`, `Allowance.ts`, `Tier.ts`, `Catalog.ts`).

## Tests are the spec

| Suite | Proves |
| --- | --- |
| `test/stories` | every command's happy path and every rejection |
| `test/properties` | the eight properties in [the correctness bar](./PLAN.md#correctness-bar), plus cross-family state conservation, money as a fold of the log, read/write agreement, the catalog and guard contract, and delivery dedupe |
| `test/conformance` | every `Payments` implementation passes the cases its capabilities declare |
| `test/surfaces` | the MCP tool list and the CLI are derived from the Apis, not written twice |
| `test/Api.test.ts` | each guard refuses what it should: no caller, another account, an operator command |

Write the property red first. A property that has never failed proves nothing, and a rejection
without a story is unimplemented.

- Properties are generated with `effect/Arbitrary` through `test/support/Property.ts`;
  `test/properties/Arbitraries.ts` holds the command and script generators. A falsification prints
  its shrunk input and a replay token, which goes back into `replay` to reproduce it. A fixed loop
  over hand-picked inputs is an example, not a property.
- `TestClock` everywhere. A billing test that waits in real time will flake.
- Deterministic data: account ids are constants or derived from the test name. No `Math.random()`
  and no `Date.now()` for identity.
- Poll with `Effect.repeat` + `Schedule` and a bounded `times`, never
  `while (Date.now() < deadline)`.
- A bug found in the wild lands as the smallest story that reproduces it, with the event log
  that produced it pasted beside it.

## Working here

1. **Orient.** Read [the milestones](./PLAN.md#milestones) and the PLAN section you are about to
   touch. The plan is the spec; this file is the working agreement. When the code and the plan
   disagree, the plan wins — or the plan is genuinely out of date, and you change it on purpose,
   in its own commit, saying why.
2. **Build in milestone order.** M0 → M6. Do not open M(n+1) until M(n)'s exit criterion holds,
   and do not widen a milestone with a feature from a later one.
3. **Model, then store, then providers.** The model is proven against `Domain.InMemory` before a
   SQL store exists.
4. **Gate before done.** The root gates are `pnpm typecheck` and `pnpm test`; both green. Fix
   the check rather than the test.

## Further reading

- [PLAN.md](./PLAN.md) — design of record.
- [Root AGENTS.md](../../AGENTS.md) — workspace layout, versioning, Effect discipline, git.
- [Alchemy AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md) — engine
  concepts, the Reconciler doctrine and binding conventions. Read the Reconciler doctrine before
  writing `Diff` / `Read` / `Reconcile` / `Delete` for a store.
- [Alchemy source mirror](../../.agent_sources/github.com/alchemy-run/alchemy/) — once vendored,
  the pinned source for the API rules above:
  `packages/alchemy/src/{Resource,Input,Contributions}.ts` and
  `packages/domain/src/{Command,Event,Rejection}.ts`.
