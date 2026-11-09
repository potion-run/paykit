# Billing surface

paykit is a library on Alchemy, not a hosted billing service. It owns the billing model, the event
log, the read models and the Alchemy resources that provision a vendor. The provider owns the money
plane; the deployment owns the HTTP surface, the console and everything operational. This page maps
the reference billing surface onto that split, so a gap is either ours, the provider's or the
deployment's — and a claim in `NEXT.md`, an ADR or a README can be checked here.

The reference product is not named in code, comments, docs or tests. "Reference" means its
documented billing surface, not a second implementation.

**Legend**

| Status | Means |
| --- | --- |
| **shipped** | the library has it, with tests and a gate on `main` |
| **modelled** | ADR + Quint model (+ brief); the TypeScript is the next slice |
| **partial** | a narrower version exists; the difference is named |
| **provider** | the `Payments` port or the vendor owns it; the library only records the fact |
| **deployment** | not a library concern; the app or the console owns it |
| **missing** | ours, with no design yet |

## The model — paykit owns

| Reference | paykit | Status |
| --- | --- | --- |
| Plans | `Plan` / `Tier`, the catalog, `Attach` / `Update` | shipped |
| Features | `Feature`, `FeatureId`, rate cards | shipped |
| Plan items | `PlanItem` / `Allowance`, `planItem()` | shipped |
| Subscriptions | the standing, `StandingPhase`, plan operations | shipped |
| Balances | `Balance` + `BalanceSource`, `balances.qnt` | shipped |
| Recurring plans | `included`, `resets`, every interval | shipped |
| Plan variants | `variantOf` / `customize` | shipped |
| One-off purchases | `kind: "one_off"` packs, `PurchaseCredits`, `balances.create` grants | shipped |
| Free plans | a plan with no price | shipped |
| Credit systems | `Feature.creditRates` / `rateCard`, one pool per account | shipped |
| Dimensions & rate cards | `RateRule`, `RateMultiplier`, `dimension` on a track | shipped |
| Prepaid pricing | one-off packs, lifetime grants, `BalanceSource` | shipped |
| Usage-based pricing | `overage: "bill"`, `unitPrice` / `pricing`, `PeriodCloseUsage` | shipped |
| Per-unit pricing | `kind: "non_consumable"` seats, `SetQuantity` / `SetUsage` | shipped |
| Rollovers | `carryOver` / `carryCap`, `balances.qnt` | shipped |
| Proration | `Proration`, `ChargeProration`, `ChargeQuantityProration` | shipped |
| Trials | `StartTrial`, `TrialStarted`, the trial latch | shipped — a card-required trial is the provider's checkout |
| Auto top-ups | `autoTopUp` policy, `topUp` line, cooldown and retry budget (ADRs 0013–0031) | shipped |
| Spend limits & usage alerts | `BillingControls`, `SpendLimitExceeded`, `UsageAlertFired` (ADR 0038) | shipped |
| Add-ons | `plans` plus `schedule`, `multiAttach` / `multiUpdate`, `addAddOn`, group cancellation, a bespoke custom add-on (ADRs 0039, 0042) | shipped |
| Graduated pricing | `_tag: "graduated"`, one `PricedLine` per band | shipped |
| Volume-based tiers | `_tag: "volume"`, the delta at the landed band | shipped |
| Entity plans | `EntityId`, `ScopeState` per entity, `entityId` on `ChangeTier`, `Attach`, `Update` and previews (ADR 0040) | shipped |
| Entities and transfer | `AttachEntity` / `UpdateEntity` / `ArchiveEntity` / `TransferBalance`, `Entities` / `TransferBalance`, `ScopeRef`, pooled items, `Balance.scope` (ADR 0040) | shipped — the model, reads, bindings, layers, Api commands, `Atom` verbs and the SQL-backed entity list |
| Custom plans | `Plan.custom`, `CatalogGuard`'s structural rule, `Attach({ planId, grants, price })`, the pending quote on a checkout (ADRs 0041, 0042) | shipped — a bespoke set and a negotiated price ride the command and the event; a priced first activation stores its quote and the webhook activates exactly it |
| Versioning plans | the catalog is deploy-time data; a price change never reprices history | partial — no versioned plan migration for existing subscribers |
| Creating customers | activation or a controls write creates the customer; `Customers.get` reads it | partial — no `customers.create` / `getOrCreate` |
| Managing customers | `Paykit.Customers(account)`, `BillingState` | shipped |
| Checking access | `Check` | shipped |
| Tracking usage | `TrackUsage` | shipped |
| Balance locking | `Hold` / `SettleHold` / `ReleaseHold`, `check({ lock })` | shipped |
| Managing balances | `Balances` list/get/create/update/finalize | shipped |
| Billing controls | `SetBillingControls`, `Customers.update` | shipped — customer-level; entity-level is deferred |
| Rewards and referrals | — | missing — a new balance source and its own protocol, not a flag on a plan |

## The money plane — the provider owns

| Reference | paykit | Status |
| --- | --- | --- |
| Payment flow | checkout, `Portal`, the `Payments` port | shipped — the library hands back the provider's URL |
| Refunds and reversals | `Refund` / `ReverseRefund` commands, `Payments.refund`, the operator console | shipped — the provider moves the money, the log records the fact |
| Dunning and billing reliability | `PaymentFailed`, `GraceEntered`, the dunning ladder | shipped — 3DS and the card UI are the provider's |
| Vendor sync | `StripePrices` / `PolarPrices` provision prices, products and meters; webhooks apply provider facts | partial — one-way provisioning, not a two-way sync |
| Tax | — | provider — the vendor calculates and collects it |
| Setup payment | `Payments.setupPayment`, `Paykit.SetupPayment` | shipped — the provider hosts the page; the library records nothing (ADR 0046) |
| Migration from a vendor account | — | missing — a deployment migration, not a model rule |

## The deployment plane — not the library

| Reference | Owner | Why |
| --- | --- | --- |
| A hosted dashboard | deployment | paykit serves the read models (`BillingState`, `Entitlements`, `List`, `Balance`); `paykit-admin` is an optional console package |
| A billing page | deployment | `Atom` and the read models are the client surface; the screens are the example's job |
| Webhooks | paykit + deployment | the decoders and the outbound policy are the library's; the endpoint is the deployment's |
| Chat or email notifications | deployment | `Outbound` signs and delivers the stream; a receiver formats the message |
| Approval rules | deployment | the actor model and `Guards` answer "who may act"; a per-action approval flow is an app decision |
| Fail-open / edge cache | deployment | `check` reads local state and never calls a provider; a last-known cache is a deployment choice |
| Rate limits | deployment | the Api and the handler are served by the deployment's edge |
| SQL over customer data | deployment | `BillingReadStore`/`List` are the read model; ad-hoc SQL is a deployment analytics concern |
| AI SDK, router, mobile-store and marketplace integrations | deployment | each is a vendor adapter over `track` and `check`, not a model rule |
| A config-sync CLI | deployment | `BillingCli` derives one subcommand per Api command; a config-file sync is a deployment tool |

## What is actually ours to build

1. **The plan set / multi-attach / schedules** — landed (ADR 0039): the plan set and its phase
   schedule, `multiAttach` / `multiUpdate` as one command id and one transaction, one balance source
   per plan in `Balance.breakdown`, the `isDefault`-aware `CancelGroup` / `UncancelGroup`, a phase
   applied at its own instant by `PlanPhaseSchedule`, and the `AddAddOn` binding.
2. **Entities and transfer** — shipped (ADR 0040): the scope state, the four commands, the scoped
   reads (`Balance.scope`, `balanceOfEntity`, `Entitlements.entities`, `Customer.entities`,
   `BillingReadRow.entities`), `Paykit.Entities` and
   `Paykit.TransferBalance` with their layers, `entityId` on `Balances` / `Attach` / `Update` /
   previews, the four tenant Api commands and the `Atom` verbs and mutations.
3. **Custom plans** — landed ([ADR 0041](../adr/0041-a-custom-plan-is-a-catalog-opt-in.md),
   [ADR 0042](../adr/0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md)): a plan may
   declare `custom: true`, the guard accepts a structurally valid bespoke set, a hosted checkout
   carries its quote as a pending activation, a custom add-on stacks, and a negotiated price is the
   operation's explicit override. What remains is a custom plan as a group's fallback and a quote
   keyed by provider reference if concurrent checkouts must be told apart.
4. **Plan versioning / migration** — the catalog is versionless today; a price or allowance change
   is new data, not a migration of existing subscribers.
5. **`customers.create` / `getOrCreate`** — a pre-created customer today needs an activation or a
   controls write; the verb and its read belong in the library.
6. **`setupPayment`** — landed ([ADR 0046](./adr/0046-adding-a-payment-method-is-a-port-operation.md)):
   `Payments.setupPayment` and the `"setup"` capability are on the port, `Paykit.SetupPayment(account)`
   is the in-process operation binding, Stripe opens a setup-mode Checkout Session and Polar a
   customer session. The provider hosts the page; the log records nothing.

Nothing on the deployment plane is "missing": a library that grew an edge cache, a chat formatter or
a marketplace adapter would be a second product.
