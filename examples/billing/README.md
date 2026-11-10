# Billing example

A Worker that sells three tiers, meters usage, holds allowance for work in flight, and serves the
same model over HTTP and MCP. The model runs on the D1 database declared beside it — the event log,
every read model and the entitlement a `check()` answers from are rows in one schema — and the
provider is `Manual`, which sells through an invoice and needs no key.

The tables come from paykit's own description: the deploy applies the frozen baseline
(`BILLING_SCHEMA_V1`) through the D1 HTTP API and converges it, so the schema a release applies and
the schema a test applies cannot drift — and there is no `.sql` file to keep in step.

```sh
pnpm install
pnpm --filter @potion.run/example-billing test   # the whole billing flow, no account needed
pnpm --filter @potion.run/example-billing dev    # alchemy dev
```

## What is where

| File | What it declares |
| --- | --- |
| `src/catalog.ts` | Four features and three plans. Plain data, no provider ids. |
| `src/billing.config.ts` | The provider, the catalog and the store, as one declaration. |
| `src/Billing.layer.ts` | That declaration as the world, on `Domain.InMemory`. |
| `src/Tenant.ts` | The end API: one account's verbs, taking declared features and plans. |
| `src/SqlBilling.ts` | The same model on SQL: `billingOnSql(d1)` is what the Worker and the SQL test both call. |
| `src/BillingDatabase.ts` | The D1 database, with the generated migration file. |
| `src/BillingMcp.ts` | The tenant Api as MCP tools, captured from the world the Worker built. |
| `src/BillingWorker.ts` | `/api` for an account, `/admin` for an operator, `/mcp` for an agent — from one model. |
| `alchemy.run.ts` | `Paykit.BillingStack` validates the catalog and records it; the Worker is released beside it. |
| `test/example.test.ts` | Every claim below, run in `Domain.InMemory`. |
| `test/sql.test.ts` | The same flow on a real database, through the generated migration file. |

## The catalog is deploy-time

`Paykit.BillingStack` validates three things before anything is deployed: the catalog's own references
(no duplicate tier, no grant of an undeclared feature, no empty tier), that every provider price
mapping agrees with the catalog, and that every priced tier has a provider that can actually sell
it. A catalog that fails is a defect, so the stack dies rather than half-deploying.

The catalog is not editable at runtime. A price change is a deploy that diffs, because a price
that changes at runtime has no version and no diff.

## Selling

The app calls `Tenant(account)`, and every request names a declaration from `src/catalog.ts`:

```ts
const tenant = yield* Tenant(account);

const purchased = yield* tenant.subscribe({ plan: pro });
const answer = yield* tenant.check({ feature: messages, requiredBalance: 1 });
yield* tenant.track({ feature: messages, value: 1, idempotencyKey: requestId });
```

The bindings behind it take a plain string id, because the same binding is a wire contract. `Tenant`
closes that gap once: a `Feature` or `Plan` is the only thing a verb accepts, and a feature's `kind`
decides which verbs take it — a flag cannot be tracked, and a seat is set rather than spent. The
answer, the refusals and the read-your-write wait are still the library's.

`subscribeInput` in `test/support.ts` turns a plan declaration into the fields a raw `Subscribe`
command carries. A command has to carry its own allowances and price because `decide` is pure and
cannot look them up, so `CatalogGuard` refuses any command whose allowances or price disagree with
the catalog the deployment validated. Without that guard, an Api client that forgot `price` would
write a standing that can never be reconciled against an invoice.

## Checking and tracking

```ts
const tenant = yield* Tenant(account);
const answer = yield* tenant.check({ feature: messages, requiredBalance: 1 });
// { allowed: true, balance, standing: "good" }
```

`check` answers from one local read of the `Entitlements` view. There is no provider round trip,
ever, and the preferred path is in-process before the read model and HTTP fallbacks.

`tenant.track` records usage in the same transaction that judges the allowance, so a blocking
allowance refuses before anything is written, and the `idempotencyKey` makes a retry record once.

## Holding allowance

Work that has started but not finished should not be billed, and should not be spendable twice:

```ts
const tenant = yield* Tenant(account);

const reservation = yield* tenant.hold({ feature: messages, amount: 10, dedupeKey: turnId });
const used = yield* runTheTurn();
// One call bills what ran and returns the rest.
yield* tenant.settleHold({ holdId: reservation.holdId, amount: used, dedupeKey: `${turnId}:settle` });
// Or return the whole hold without billing it.
yield* tenant.releaseHold({ holdId: reservation.holdId, dedupeKey: `${turnId}:release` });
```

A reservation moves `remaining` and `reserved`, never `usage`. `check` therefore refuses the next
caller the unit the first one holds. Settling or releasing more than is held is a typed rejection,
so a leaking reservation is an error rather than a quietly shrinking allowance.

## Showing the charge first

```ts
const tenant = yield* Tenant(account);
const result = yield* tenant.preview({ kind: "changeTier", plan: scale });
if (result._tag === "accepted") console.log(result.proration?.due);
```

A preview runs the same pure `decide` the model runs, so it cannot disagree with the write it
previews. It reports the events that would be recorded and the proration that would be charged, and
records nothing.

## Two surfaces, one model

`src/BillingWorker.ts` serves `/api` from `BillingApi` and `/admin` from `BillingAdminApi`. They differ in
authorization, not in model:

- `Session` resolves the caller and pins an account to itself. Both views declare it and re-check
  the key, so a read is scoped even if a route forgot to be.
- `Admin` requires an operator. `GrantCredits`, `ExtendTrial`, `Expire` and the payment commands
  declare it, so a tenant session cannot reach them at all.

The guards here are `InsecureSessionFromHeaders` and `InsecureAdminFromHeaders`, which read `x-paykit-actor` and
`x-paykit-kind`. They are development guards: a real deployment provides a `Session` Layer over its
own session and keeps `Admin` stricter still.

```sh
curl -X POST localhost:8787/api \
  -H 'x-paykit-actor: acct_123' \
  -H 'content-type: application/json' \
  -d '{"_tag":"TrackUsage","target":"acct_123","input":{"feature":"messages","amount":1}}'
```

## The same Api as MCP tools

```ts
import { BillingMcp } from "@potion.run/paykit/Surfaces";
```

`BillingMcp` is `DomainAi.toMcp(BillingApi)`: one tool per command and per non-stream read, named
`BillingApi_TrackUsage_send` and so on, `Destructive` for a command and `Readonly` for a read. Each
tool call runs the Api's own middleware with the MCP request's headers, so an agent can only reach
what the account it acts for can reach. There is no second tool list to keep in step.

`BillingCli` is `DomainCli.toCli(BillingAdminApi)`: one subcommand per served entry.

## Where the data lives

`billingOnSql(d1)` is the whole wiring, and `d1` is the only platform-specific piece — which is why
`test/sql.test.ts` can run the same function over SQLite. In the Worker it is
`Cloudflare.D1.QueryDatabase(BillingDatabase)`; in a test it is a `D1Like` over `bun:sqlite`.

A command writes its events, the state after them, its receipt and its outbox rows in one unit; the
view that answers `check()` writes its snapshot, its entries and its input rows in one unit. On D1
that unit is one atomic `batch`. A test asserts the event row and the `Entitlements` row are in the
same database after a subscribe.

## Swapping in a real provider

1. Add the peer: `@alchemy.run/stripe`, or `@potion.run/paykit-polar` for Polar.
2. Replace `Manual()` with `Stripe()` in `src/billing.config.ts` and map tiers to price handles in the
   provider config. The catalog does not move, and no file under `src/` changes shape.
3. Point the provider's webhook endpoint at `handleWebhook`. The provider's event id becomes the
   command id, so a redelivery is a replay rather than a second charge.

## Other variants

| Example | The axis it changes |
| --- | --- |
| [`examples/saas`](../saas) | The whole product: sign-up, projects, transfers, an add-on, guardrails and the metered turn. |
| [`examples/memory`](../memory) | The smallest deployment: `MemoryStore`, `Manual`, no database or key. |
| [`examples/stripe`](../stripe) | `StripeBilling` provisions prices and meters; the Worker resolves the lookup keys. |
| [`examples/postgres`](../postgres) | The model on Postgres through Cloudflare Hyperdrive. |
| [`examples/polar`](../polar) | `PolarBilling` provisions a product; the Worker sells it. |
| [`examples/auth`](../auth) | Better Auth on D1 and the provider-neutral session resolver. |
| [`examples/admin`](../admin) | The Foldkit console over `BillingAdminApi`. |
| [`examples/tanstack`](../tanstack) | A TanStack Start UI on the Effect Atom client. |

## Destroying this stack

`Paykit.BillingStack` records its state with `RemovalPolicy.RETAIN`, and nothing in a delete path cancels,
refunds or deletes provider state. The event log is application data, not stack state: a `destroy`
that cancelled a live subscription would be a support incident, so it cannot happen.
