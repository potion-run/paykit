---
title: "Paykit"
description: "Billing and entitlement for Alchemy."
sidebar:
  label: Overview
---

Billing and entitlement for Alchemy.

## Entry points

| Import | Source |
| --- | --- |
| `@potion.run/paykit` | [`src/index.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/index.ts) |
| `@potion.run/paykit/Admin` | [`src/Admin.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Admin.ts) |
| `@potion.run/paykit/Atom` | [`src/Atom.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Atom.ts) |
| `@potion.run/paykit/Billing` | [`src/Billing/index.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/index.ts) |
| `@potion.run/paykit/Foldkit` | [`src/Foldkit.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Foldkit.ts) |
| `@potion.run/paykit/Read` | [`src/Read.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Read.ts) |
| `@potion.run/paykit/Surfaces` | [`src/Surfaces.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Surfaces.ts) |
| `@potion.run/paykit/Webhooks` | [`src/Webhooks.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Webhooks.ts) |
| `@potion.run/paykit/Database` | [`src/Database/index.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/index.ts) |
| `@potion.run/paykit/Database/Postgres` | [`src/Database/Postgres.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/Postgres.ts) |
| `@potion.run/paykit/Database/Sqlite` | [`src/Database/Sqlite.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/Sqlite.ts) |
| `@potion.run/paykit/Database/D1` | [`src/Database/D1.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/D1.ts) |
| `@potion.run/paykit/Database/Drizzle` | [`src/Database/Drizzle.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/Drizzle.ts) |
| `@potion.run/paykit/Database/MySQL` | [`src/Database/MySQL.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Database/MySQL.ts) |

## Modules

- [actionsFor](/reference/paykit/actions-for): The actions that make sense for a standing, in a stable display order.
- [BillingMcp](/reference/paykit/billing-mcp): The surfaces an Api projects onto, without a second declaration.
- [BillingStack](/reference/paykit/billing-stack): The deploy-time billing stack, in one call.
- [BillingStack.resource](/reference/paykit/billing-stack-resource): The deploy-time billing stack: it records the validated catalog, the provider descriptors and the store kind, retains on removal, and versions that state shape with BILLING_STACK_VERSION.
- [CatalogGuard](/reference/paykit/catalog-guard): Exports `CatalogGuard`, `CatalogGuardLive`.
- [CatalogRpc](/reference/paykit/catalog-rpc): Exports `PaykitCatalogRpcs`, `PaykitCatalogClient`.
- [doctor](/reference/paykit/doctor): Rebuild every read model from billing_event and diff it.
- [Handler](/reference/paykit/handler): Exports `moneyRoutes`, `handler`.
- [httpStatus](/reference/paykit/http-status): The HTTP status a paykit refusal deserves.
- [make](/reference/paykit/make): Billing as Effect atoms: the tenant bindings, shaped for a client.
- [Outbound](/reference/paykit/outbound): The outbound edge as a port: the endpoints to notify and the transport that sends a signed request.
- [Paykit](/reference/paykit/paykit): The four export groups as one namespace, so the docs' Paykit.feature(...) and the flat named exports are the same functions.
- [Payments](/reference/paykit/payments): Exports `providerSet`, `resolveProvider`.
- [planVersionOf](/reference/paykit/plan-version-of): The generation of a plan's terms the catalog currently sells, or null when the catalog has no such plan.
- [providers](/reference/paykit/providers): Every Alchemy provider this package owns, as one Layer, so a stack declares Paykit.providers() beside Cloudflare.providers().
- [resolvePolarProductId](/reference/paykit/resolve-polar-product-id): Resolve a tier's product handle to the id Polar's API expects.
- [TierCommand](/reference/paykit/tier-command): Exports `TierGrantInput`, `withGrants`, `subscribeInputOf`, `scheduleTierChangeInputOf`, `purchaseCreditsInputOf`, `planChangeTier`.
- [timelineOf](/reference/paykit/timeline-of): Fold a log into a timeline.
- [Verify](/reference/paykit/verify): Check one account's standing against the catalog and the configured provider.
- [Webhooks](/reference/paykit/webhooks): Exports `WEBHOOK_TRANSITIONS`, `webhookActionOf`.
- [world](/reference/paykit/world): One deployment graph, built from the parts a host chooses.

### Admin

- [ChangeTier](/reference/paykit/admin/change-tier): Exports `AdminChangeTier`, `AdminChangeTierClient`.
- [Reads](/reference/paykit/admin/reads): Exports `AdminReads`, `makeAdminReads`, `AdminReadsClient`.
- [Refund](/reference/paykit/admin/refund): Exports `AdminRefund`, `AdminRefundClient`.

### Auth

- [Actor](/reference/paykit/auth/actor): The caller of a request, provided by the Session or Admin middleware and carried with the command.
- [FromHeaders](/reference/paykit/auth/from-headers): Exports `accountFromHeaders`, `InsecureSessionFromHeaders`, `InsecureAdminFromHeaders`, `InsecureDevGuards`.
- [FromResolver](/reference/paykit/auth/from-resolver): Exports `ActorResolver`, `SessionFrom`, `authenticate`, `AdminFrom`, `GuardsFrom`.
- [Guards](/reference/paykit/auth/guards): Exports `Session`, `Admin`.

### Billing

- [AddAddOn](/reference/paykit/billing/add-add-on): Attach an add-on plan beside whatever the account already runs.
- [Admin](/reference/paykit/billing/admin): Exports `GrantCredits`, `ExtendTrial`, `EnterGrace`, `Recover`, `Expire`, `RecordPayment`, `RecordPaymentFailure`, `Refund`.
- [Attach](/reference/paykit/billing/attach): Exports `Attach`, `Update`, `PreviewAttach`, `PreviewUpdate`.
- [Balances](/reference/paykit/billing/balances): A customer's balances: the read side of the entitlement plane, one shape for check, track and this.
- [Balances.layer](/reference/paykit/billing/balances-layer): Exports `BalancesRead`, `BalancesLive`.
- [BillingAdminApiLayer](/reference/paykit/billing/billing-admin-api-layer): Every operator binding, implemented over BillingAdminApi — the Api whose commands declare Admin, so a tenant session cannot reach one.
- [BillingAdminInProcess](/reference/paykit/billing/billing-admin-in-process): Every operator binding, implemented in the process that hosts the model.
- [BillingApiLayer](/reference/paykit/billing/billing-api-layer): Every paykit tenant binding, implemented over BillingApi — the Api's own Session middleware decides whether this caller may act for this account, and its reply decoding turns a rejection back into the class a caller matches.
- [BillingInProcess](/reference/paykit/billing/billing-in-process): Every paykit binding, implemented in the process that hosts the model.
- [Bindings](/reference/paykit/billing/bindings): Exports `BindingFailed`, `BindingCall`.
- [Cancel](/reference/paykit/billing/cancel): Exports `ScheduleCancellation`, `Resume`.
- [ChangeTier](/reference/paykit/billing/change-tier): Change the tier a standing is on.
- [ChargeQuantityProration](/reference/paykit/billing/charge-quantity-proration): Collect the money a quantity change moved.
- [Check](/reference/paykit/billing/check): The entitlement plane: one local read, no provider round trip, and the balance the customer has of one feature.
- [CheckOverTransport](/reference/paykit/billing/check-over-transport): Check over a transport: delegate the question to whatever serves the entitlement elsewhere — an HTTP call, a Durable Object, another Worker's binding.
- [CheckReadModel](/reference/paykit/billing/check-read-model): Check over the edge read model: one row from billing_rm_, no event fold and no view to resolve.
- [Commands](/reference/paykit/billing/commands): Exports `BillingCommands`, `BillingCommandsLive`, `BillingCommandsClient`.
- [ConsumeCredits](/reference/paykit/billing/consume-credits): Spend credits from the account's pool: one pool per account, whatever feature the work belonged to.
- [CreateCustomer](/reference/paykit/billing/create-customer): Record the identity a billing page shows for this account: its name and its email address.
- [Customers](/reference/paykit/billing/customers): A customer's record: the identity it recorded, the plans it holds and the controls it states over them.
- [Customers.layer](/reference/paykit/billing/customers-layer): Exports `CustomersRead`, `CustomersLive`.
- [Entities](/reference/paykit/billing/entities): A customer's child scopes: a team, a project, a workspace.
- [Entities.layer](/reference/paykit/billing/entities-layer): Exports `EntitiesRead`, `EntityWrites`, `EntitiesLive`.
- [GrantBalance](/reference/paykit/billing/grant-balance): Create a standalone grant of a counted feature: the API behind Paykit.Balances(account).create.
- [Hold](/reference/paykit/billing/hold): Hold capacity for work that has not finished: an agent turn, a long job, a request whose cost is known up front.
- [List](/reference/paykit/billing/list): One page of accounts, in a stable cursor order.
- [MultiPlan](/reference/paykit/billing/multi-plan): Exports `MultiAttach`, `MultiUpdate`.
- [Portal](/reference/paykit/billing/portal): Exports `Portal`, `ChargeProration`.
- [Preview](/reference/paykit/billing/preview): Run the model's pure decide and report what a command would produce: the events, the state after them, and the proration it would charge.
- [ReleaseHold](/reference/paykit/billing/release-hold): Return a hold without billing it: the work failed, was cancelled, or never ran.
- [ScheduleTierChange](/reference/paykit/billing/schedule-tier-change): Exports `ScheduleTierChange`, `WithdrawTierChange`.
- [SetBillingControls](/reference/paykit/billing/set-billing-controls): Replace a customer's billing controls: its auto top-up line, its spend ceilings and its usage alerts (ADR 0038).
- [SetQuantity](/reference/paykit/billing/set-quantity): Set a non-consumable feature's quantity.
- [SettleHold](/reference/paykit/billing/settle-hold): Turn a hold into usage: bill what ran and return the rest, in the same command.
- [SetupPayment](/reference/paykit/billing/setup-payment): Add a payment method without a purchase.
- [SetUsage](/reference/paykit/billing/set-usage): Set how much of a non-consumable feature is in use.
- [StartTrial](/reference/paykit/billing/start-trial): Open a trial on a tier.
- [Subscribe](/reference/paykit/billing/subscribe): The one door to a purchase.
- [TrackUsage](/reference/paykit/billing/track-usage): Record usage in the same transaction that checks the allowance.
- [TransferBalance](/reference/paykit/billing/transfer-balance): Move balance units between the customer's own scope and one of its entities, or between two entities.
- [TransferBalance.layer](/reference/paykit/billing/transfer-balance-layer): Exports `TransferBalanceWrite`, `TransferBalanceLive`.
- [Webhook](/reference/paykit/billing/webhook): The webhook edge as a binding: the model's services resolved once, an event applied per delivery.

### Database

- [D1](/reference/paykit/database/d1): A Cloudflare D1 billing database.
- [Database](/reference/paykit/database/database): Exports `DatabaseService`, `Database`.
- [Drizzle](/reference/paykit/database/drizzle): The billing model on a Postgres database a Drizzle instance already opened.
- [MySQL](/reference/paykit/database/my-sql): A MySQL billing database, from any connection source.
- [Postgres](/reference/paykit/database/postgres): A Postgres billing database, from any connection source: a Hyperdrive connection string, Neon, PlanetScale Postgres, RDS, or a literal URL.
- [registerMigrations](/reference/paykit/database/register-migrations): Register the deploy-time migration Action for a Database, mirroring Alchemy's own BetterAuth.Migrate.
- [Sqlite](/reference/paykit/database/sqlite): A bun:sqlite billing database — development, tests, and a single-process host.

### Migrations

- [converge](/reference/paykit/migrations/converge): Converge the shipped description against the target, additively.
- [Migrations](/reference/paykit/migrations/migrations): Exports `migrationFiles`, `schemaFingerprint`, `migrationFingerprint`, `migrateDryRun`, `migrate`, `sync`.

### Store

- [d1Executor](/reference/paykit/store/d1-executor): A SqlExecutor over Cloudflare's D1, implementing the asynchronous half of the port that Alchemy's D1 executor implements (@alchemy.run/cloudflare/D1/ApplyMigrations, makeD1MigrationExecutor): query/get for reads, write/batch for writes, and atomic for a unit.
- [mysqlExecutor](/reference/paykit/store/mysql-executor): A SqlExecutor over an @effect/sql-mysql2 client — the client @alchemy.run/sql/MySQL builds from a connection URL.
- [PostgresDriver](/reference/paykit/store/postgres-driver): Exports `toPostgresPlaceholders`, `postgresExecutor`, `pgPoolExecutor`.
- [SqlAggregateStore](/reference/paykit/store/sql-aggregate-store): A Domain.AggregateStore over SqlEventLog.
- [SqlBillingReadStore](/reference/paykit/store/sql-billing-read-store): The projection's port, backed by the same database as the event log: one schema holds the truth and its read models, so a dashboard, the edge read path and doctor all see the same rows without a second store to drift.
- [SqlConsumers](/reference/paykit/store/sql-consumers): Exports `SqlViewStore`, `SqlPolicyStore`, `SqlStreamStore`.
- [SqlEventLog](/reference/paykit/store/sql-event-log): The durable half of the store: events are the truth, receipts dedupe by command id, the outbox carries deliveries, and the read model is rebuildable.
- [SqlPlatform](/reference/paykit/store/sql-platform): Exports `SqlPlatform`, `layerSqlPlatform`.

### Subscription

- [ArchiveEntity](/reference/paykit/subscription/archive-entity): Archive an entity and sweep its unspent own sources to the customer in the same command.
- [AttachEntity](/reference/paykit/subscription/attach-entity): Create an entity under a customer.
- [autoTopUp](/reference/paykit/subscription/auto-top-up): The auto top-up policy's configuration.
- [CreateCustomer](/reference/paykit/subscription/create-customer): Record the customer's identity: the name and email a billing page shows.
- [dunning](/reference/paykit/subscription/dunning): Turn on a dunning retry ladder.
- [HoldPhase](/reference/paykit/subscription/hold-phase): Exports `HOLD_STATUS_TRANSITIONS`, `nextHoldStatus`.
- [StandingPhase](/reference/paykit/subscription/standing-phase): Exports `standingPhaseOf`, `standingPhaseOfView`, `standingPhaseTagOfStatus`, `standingConditionsOf`, `STANDING_PHASE_TRANSITIONS`, `nextStandingPhase`, `standingTransitionOf`, `STANDING_PHASE_EDGES`.
- [TransferBalance](/reference/paykit/subscription/transfer-balance): Move units between two scopes of one customer: the customer's own scope and one of its entities, or two entities.
- [UpdateEntity](/reference/paykit/subscription/update-entity): Rename an entity, or clear its name.
