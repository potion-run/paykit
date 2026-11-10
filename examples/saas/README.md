# SaaS example

A support desk on paykit: an organization signs up, opens projects, answers
conversations with a model, and pays for a shared pool, seats and credits. It is
the example that puts the whole product on one stack instead of isolating one
axis — the six surfaces no other example exercises are the reason it exists:

| The product does | The library surface |
| --- | --- |
| An org signs up before it buys | `Customers.getOrCreate`, `CustomerCreated` (ADR 0045) |
| It opens three projects under one billing account | `Entities` / `EntityId`, one aggregate, filtered reads (ADR 0040) |
| A project gets its own 500 conversations | a standalone balance source, `Balances.create` |
| One project's units move to a sibling | `TransferBalance`, own sources only (ADR 0040 §5) |
| A project buys an add-on allowance | `Attach` with `addOn: true` and `entityId` (ADR 0039 §2) |
| A project is closed and its units return | `ArchiveEntity`, `EntityHasOccupancy` (ADR 0040 §7) |
| The org sets a monthly overage ceiling | `SetBillingControls`, `SpendLimitExceeded` (ADR 0038) |
| The org is paged at 2,000 conversations | `CustomerUsageAlert`, `UsageAlertFired` (ADR 0038) |
| Every turn records a conversation and spends credits | `Check`, `TrackUsage`, `ConsumeCredits` |
| A retried turn records nothing twice | the caller's request id as the command id |

```sh
pnpm install
pnpm --filter @potion.run/example-saas test   # the whole flow, no account needed
pnpm --filter @potion.run/example-saas dev    # alchemy dev
```

## What is where

| File | What it declares |
| --- | --- |
| `src/catalog.ts` | Four features, three plans, one add-on. Plain data, no provider ids. |
| `src/billing.config.ts` | The provider, the catalog and the store, as one declaration. |
| `src/Billing.layer.ts` | That declaration as the world, on `Domain.InMemory`. |
| `src/Workspace.ts` | The project verbs: create, grant, transfer, occupy, add the add-on, archive. |
| `src/Agent.ts` | The metered turn, and the customer's guardrails in product words. |
| `src/SqlBilling.ts` | The same model on SQL: `billingOn(d1)` is what the Worker and the SQL test both call. |
| `src/BillingDatabase.ts` | The D1 database, with the generated migration file. |
| `src/SaasWorker.ts` | `/api`, `/plans`, `/checkout`, `/webhooks` and the product's own `/ask`. |
| `alchemy.run.ts` | `Paykit.BillingStack` validates the catalog and records it; the Worker is released beside it. |
| `test/signup.test.ts` | Sign-up, the free plan, the idempotent project create. |
| `test/workspace.test.ts` | Grant, transfer, add-on, occupancy, archive and the sweep. |
| `test/agent.test.ts` | A turn, a retry, the alert, the ceiling and the empty wallet. |
| `test/sql.test.ts` | The same flow on a real database, through the generated migration file. |

## The catalog is the product

The org's plan is `pro`: 2,000 conversations a month, pooled, so every project
draws one shared source; five seats; 5,000 credits. Past the included amount a
conversation bills two cents, up to 10,000 more, and what the month did not
spend rolls over. `scale` raises the pool to unlimited and adds SSO, and
`studio` is an add-on that gives one project its own 500 conversations and two
seats before the shared pool.

```ts
export const pro = Paykit.plan({
  id: "pro",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  credits: 5_000,
  grants: [
    Paykit.planItem(conversations, {
      included: 2_000,
      overage: "bill",
      cap: 10_000,
      unitPrice: { amount: 2, currency: "usd" },
      carryOver: true,
      carryCap: 5_000,
      pooled: true,
    }),
    Paykit.planItem(seats, { included: 5, resets: "never" }),
  ],
});
```

A catalog is not editable at runtime. A price change is a deploy that diffs,
because a price that changes at runtime has no version and no diff.

## The turn

`Agent.answer` is the product's request path, and the order is the billing
order:

```ts
const { answer } = yield* answering;

const asked = yield* check({ featureId: conversations.id, requiredBalance: 1, entityId: project });
if (!asked.allowed) return refused(402, asked.balance.spendLimit?.remaining === 0
  ? "spend_limit"
  : "allowance");

const wallet = yield* check({ featureId: ai.id, requiredBalance: costOf(model) });
if (!wallet.allowed) return refused(402, "credits");

const reply = yield* theModel(prompt);          // the only part this example fakes

yield* track({
  featureId: conversations.id,
  entityId: project,
  value: 1,
  idempotencyKey: `${requestId}:conversation`,
});
yield* consumeCredits({ amount: costOf(model), dedupeKey: `${requestId}:credits` });
```

Both checks read one local row, so the page renders without a provider call. The
two writes carry the same caller request id, so a retried request replays the
conversation and the credit spend instead of recording a second of each. A turn
that cannot afford the model never records the conversation first.

The `/ask` route always names a project, so a typo cannot silently bill the
organization. A turn with no project is the organization's own scope, and that is
where a plan's billed overage is judged today: a project sees the shared pool as
one count, so a shared pool that bills overage is judged from the org, not the
child scope. `test/agent.test.ts` drives that path in process.

## Projects are scopes, not customers

A project has one parent, no children, and no aggregate of its own. The org is
the only writer: a command that names a project commits in the org's transaction
with the project's id on the event. A transfer between two projects is one
command and one transaction, and it moves own units only — never the shared
pool, never a seat's occupancy (ADR 0040 §5–6). Archiving is refused while a
project has people in seats, and when it succeeds it sweeps the project's own
units back to the org in the same event. The event log, the project's history and
every bill it produced are kept.

## The guardrails

`setGuardrails` writes the customer's controls in the product's words:

```ts
yield* setGuardrails(account, { monthlyCeiling: 100, alertAt: 2_000 });
```

`monthlyCeiling` is money, in minor units: the most `conversations` may bill this
period. It is enforced in addition to the plan's `cap`, and a refusal leaves the
standing `good` — the account used what it allowed itself. `alertAt` records an
`UsageAlertFired` once per period; an alert is evidence, never a refusal. Both
are customer state, not catalog data, so support can change them without a
deploy, and the log records what was in force when each spend happened.

## The Worker

`SaasWorker` serves one model on one D1 database:

- `/api` — `BillingApi`: customers, projects, balances, transfers, guardrails.
- `/plans` — the plan operations: attach, update, preview, checked out.
- `/checkout` — the provider's purchase path.
- `/webhooks` — the provider's deliveries, verified and applied.
- `/ask` — the product's own metered route, tried before the built-ins.

The billing surface is `Paykit.handler`, so a refusal answers
`Paykit.httpStatus` and there is no second status table. `/ask` is the example's
own route, and it is built from the model the handler already serves, not a
second copy:

```sh
curl -X POST 'localhost:8787/ask?project=proj_docs&model=gpt-large' \
  -H 'x-paykit-actor: acct_saas' \
  -H 'x-request-id: turn-42'
# 402 {"refused":"spend_limit","message":"SpendLimitExceeded"} | 200 {"reply":...,"remaining":...,"credits":...}
```

The account header is the example's stand-in for a session. A real deployment
resolves its own actor, as `examples/auth` does with Better Auth, and the routes
do not change.

## What this example does not wire

- **The refill line.** `Paykit.autoTopUp` is a policy layer a deployment provides
  on its own model; `Paykit.world` does not take it, so a catalog `topUp` line
  would state a refill that never fires. Add it when the world grows the seam.
- **A real model and a real provider.** `/ask` echoes the prompt, and
  `Paykit.Memory()` moves no money. Swapping either keeps the billing shape: the
  provider is one line in `billing.config.ts`, and the model call is the one line
  between the checks and the writes.
- **Tax, a portal and dunning** stay the provider's; the library records the
  facts and `examples/admin` is the console over them.

## Variants on the same model

| Example | The axis it changes |
| --- | --- |
| [`examples/memory`](../memory) | The smallest deployment: `MemoryStore`, `Manual`, no database or key. |
| [`examples/billing`](../billing) | The same model on D1 with the console and MCP. |
| [`examples/stripe`](../stripe) | `StripeBilling` provisions prices and meters; the Worker resolves the lookup keys. |
| [`examples/polar`](../polar) | `PolarBilling` provisions a product; the Worker sells it. |
| [`examples/postgres`](../postgres) | The model on Postgres through Cloudflare Hyperdrive. |
| [`examples/mysql`](../mysql) | The model on MySQL. |
| [`examples/drizzle`](../drizzle) | The `pg` pool a Drizzle instance already opened. |
| [`examples/auth`](../auth) | Better Auth on D1 and the provider-neutral session resolver. |
| [`examples/admin`](../admin) | The Foldkit console over `BillingAdminApi`. |
| [`examples/tanstack`](../tanstack) | A TanStack Start UI on the Effect Atom client. |
