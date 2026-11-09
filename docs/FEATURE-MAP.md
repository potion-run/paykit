# Feature map

The library is built toward feature parity with the reference product's documented surface. This
page is the map: every feature the reference exposes, what paykit has, and what is still missing. It
exists so a claim in `NEXT.md`, an ADR or a README can be checked against one place instead of
guessed from the source.

The reference product is not named in code, comments, docs or tests (the same rule the catalog and
plan briefs follow). "Reference" below means its documented surface, not a second implementation.

**Legend**

| Status | Means |
| --- | --- |
| **shipped** | code, tests and a gate on `main` |
| **modelled** | ADR + Quint model (+ brief); the TypeScript is the next slice |
| **partial** | a narrower version exists; the difference is named |
| **missing** | no design, no code |
| **by design** | not a library concern; the reason is named |

## Concepts

| Reference | paykit | Status |
| --- | --- | --- |
| Plans | `Plan` / `Tier`, the catalog, `Attach` / `Update` | shipped |
| Features | `Feature`, `FeatureId`, rate cards | shipped |
| Plan items | `PlanItem` / `Allowance`, `planItem()` | shipped |
| Subscriptions | the standing, `StandingPhase`, plan operations | shipped |
| Balances | `Balance` + `BalanceSource`, `balances.qnt` | shipped |
| Vendor sync | `StripePrices` / `PolarPrices` provision prices, products and meters; webhooks apply provider facts | partial — one-way provisioning, not a two-way catalog/subscription sync |
| Migration from a vendor account | — | missing |
| MCP server | `BillingMcp`, `BillingAdminMcp` (`Surfaces`) | shipped |
| Setup and payments | `Checkout`, `Payments`, `Portal`, `handler` | shipped |
| Checking and tracking | `Check`, `TrackUsage`, `Hold` / `SettleHold` / `ReleaseHold` | shipped |
| A billing page | `Entitlements`, `BillingState`, `Balance`, `Timeline`, `Atom` | shipped — the screens are the examples' job |
| A production checklist | `doctor`, `Verify`, `CatalogGuard`, the handler | by design — a checklist, not a resource |

## Modelling pricing

| Reference | paykit | Status |
| --- | --- | --- |
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
| Trials | `StartTrial`, `TrialStarted`, the trial latch | shipped — card-required trials are a provider checkout, not a model rule |
| Auto top-ups | `autoTopUp` policy, `topUp` line, cooldown and retry budget (ADRs 0013–0031) | shipped |
| Spend limits & usage alerts | `BillingControls`, `SpendLimitExceeded`, `UsageAlertFired` (ADR 0038) | shipped |
| Add-ons | one plan per group, add-ons stack (ADR 0039) | modelled |
| Graduated pricing | `_tag: "graduated"`, one `PricedLine` per band | shipped |
| Volume-based tiers | `_tag: "volume"`, the delta at the landed band | shipped |
| Entity plans | entity scope + its own plan set (ADR 0040) | modelled |
| Rewards and referrals | — | missing |

## Customers

| Reference | paykit | Status |
| --- | --- | --- |
| Payment flow | checkout, `Portal`, `Payments` port | shipped |
| Subscription lifecycle | `StandingPhase`, `Attach` / `Update`, cancellation, grace, dunning | shipped |
| Updating subscriptions | `Update`, `SetQuantity`, `CancelImmediately` | shipped |
| Tax | — | missing — the provider collects tax; paykit does not model it |
| Custom plans | — | missing — `CatalogGuard` refuses allowances not in the catalog; this is the one item in `NEXT.md` a host cannot do for itself |
| Versioning plans | the catalog is deploy-time data; a price change never reprices history | partial — no versioned plan migration for existing subscribers |
| Billing reliability | grace, dunning ladder, `TopUpFailed`, `RefundReversed` | shipped — 3DS is the provider's checkout |
| Creating customers | activation or a controls write creates the customer; `Customers.get` reads it | partial — no `customers.create` / `getOrCreate` |
| Managing customers | `Paykit.Customers(account)`, `BillingState`, the admin console | shipped |
| Checking access | `Check` | shipped |
| Tracking usage | `TrackUsage` | shipped |
| Balance locking | `Hold` / `SettleHold` / `ReleaseHold`, `check({ lock })` | shipped |
| Managing balances | `Balances` list/get/create/update/finalize | shipped |
| Billing controls | `SetBillingControls`, `Customers.update` | shipped — customer-level; entity-level is deferred |
| Entities | `EntityId`, scoped balances, pooled items (ADR 0040) | modelled |

## Platform

| Reference | paykit | Status |
| --- | --- | --- |
| Webhooks | `Webhooks`, `Paykit.handler`, the provider decoders | shipped |
| Chat notifications | `Outbound` signs and delivers the stream | partial — a receiver formats the message; no built-in chat transform |
| Approval rules | the actor model and `Guards` | missing — no per-action approval flow |
| Fail-open defaults | `check` reads local state and never calls a provider | partial — a store outage is not served from a last-known cache |
| Edge cache | `CheckReadModel`, `CheckOverTransport` | missing — no cache layer |
| Rate limits | — | missing |
| SQL over customer data | `BillingReadStore`, `List`, the event log in SQL | partial — a read model, not an arbitrary SQL-over-customers endpoint |
| AI SDK integration | — | missing |
| Router integration | — | missing |
| Mobile-store integration | — | missing |
| Marketplace integration | — | missing |

## CLI and API reference

| Reference | paykit | Status |
| --- | --- | --- |
| CLI | `BillingCli` (`Surfaces`), one subcommand per Api command | partial — no config-file sync equivalent |
| Attach | `Paykit.Attach` | shipped |
| Update subscription | `Paykit.Update` | shipped |
| Open customer portal | `Paykit.Portal` | shipped |
| Setup payment | — | missing — the `Payments` port has no setup-intent operation |
| Transfer plan | `billing.transfer` (ADR 0040) | modelled |
| Multi attach | `multiAttach` (ADR 0039) | modelled |
| Multi update | `multiUpdate` (ADR 0039) | modelled |
| Create schedule | `PlanSchedule` phases (ADR 0039) | modelled |
| Verify | `Paykit.Verify` | shipped |

## The gaps, by value

1. **The plan set / multi-attach / schedules** and **entities and transfer** — modelled, with the
   plan-set implementation in progress. These are the largest parity items.
2. **Custom plans** — the one product capability a host cannot build on top: `CatalogGuard` must
   learn an explicit custom/allowlisted path.
3. **Plan versioning / migration** — the catalog is versionless today; a price or allowance change is
   new data, not a migration of existing subscribers.
4. **Tax and setup-payment** — both are provider operations the `Payments` port does not carry yet.
5. **Rewards and referrals** — a new balance source and its own protocol, not a flag on a plan.
6. **Customer creation** — a `customers.create` / `getOrCreate` verb and a pre-created enterprise flow.
7. **The platform edges** — approval rules, fail-open cache, edge cache, rate limits, SQL-over-
   customers, chat formatting, and the external-provider integrations.

## Where our docs were stale

Corrected in a previous pass:

- `docs/NEXT.md` said a top-up **retry budget** and a refund that **revokes credits** were still to
  build. Both landed: ADR 0031 (`topUpAttempts` / `RetryTopUp`) and ADR 0032 (`Refund.revokeCredits`,
  also on the console).
- `docs/NEXT.md` called all twelve lifecycle findings unfixed. `specs/paykit/FINDINGS.md` now records
  F4/F5/F7 as fixed, F2 as partly fixed (the proration identity landed; amount/currency and
  `charged` are still open), and F1/F3/F6/F8–F12 as open.
- `docs/briefs/customer-controls.md` still said "design only". It is landed, reviewed and green.
- `docs/briefs/plan-customer-balance-api.md` still called customer controls the next step. Controls
  are in; the plan set is modelled and is the next implementation.
- The model count in `specs/paykit/FINDINGS.md` said four; there are nine.
