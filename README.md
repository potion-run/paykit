# @potion.run

Billing and entitlement for [Alchemy](https://alchemy.run), on Effect. You declare a catalog beside
your stack, the library keeps each account's **standing**, and `check()` answers from local state in
one read. The provider owns the money plane; it never decides an entitlement.

| Package | What it is |
| --- | --- |
| [`@potion.run/paykit`](./packages/paykit) | billing and entitlement: catalog, model, store, providers |
| [`@potion.run/paykit-polar`](./packages/paykit-polar) | Polar as a paykit provider, in one call |
| [`@potion.run/paykit-stripe`](./packages/paykit-stripe) | Stripe as a paykit provider, in one call |
| [`@potion.run/paykit-admin`](./packages/paykit-admin) | a Foldkit ops console over `BillingAdminApi` |

[`website/`](./website) is the docs site, live at
[https://paykit.32stack.com](https://paykit.32stack.com): a private Blume app, deployed as a
Cloudflare static-asset Worker. Run it with `pnpm dev:website` and
build it with `pnpm build:website`.

## Quickstart

```sh
pnpm add @potion.run/paykit alchemy effect
```

```ts
import { Paykit } from "@potion.run/paykit";

const messages = Paykit.feature({ id: "messages", name: "Messages" });
const pro = Paykit.plan({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.planItem(messages, { included: 2_000, overage: "bill" })],
});

// One declaration, read by the deploy, the Worker and the tests.
const billing = {
  catalog: { features: [messages], tiers: [pro] },
  providers: [Paykit.Manual()],
  store: Paykit.MemoryStore(),
};

// The deploy validates the catalog, checks every provider mapping, and records
// the result in stack state in one call.
const recorded = yield* Paykit.BillingStack("Billing", billing);
```

```ts
const check = yield* Paykit.Check(account);
yield* check({ featureId: "messages" });      // { allowed, balance, standing }

const track = yield* Paykit.TrackUsage(account);
yield* track({ featureId: "messages", value: 1, idempotencyKey: requestId });

const balances = yield* Paykit.Balances(account);
yield* balances.get({ featureId: "messages" });
```

[`examples/saas`](./examples/saas) is the product rather than one axis: an organization signs up,
opens projects, gives one its own allowance, moves units between projects, stacks an add-on, sets an
overage ceiling and a usage alert, and answers a conversation with a model — every turn records usage
and spends credits from the same account. The billing account is the org; a project is an entity
scope under it, with its own sources before the org's shared pool. It runs on D1 with a keyless
provider, so the whole flow is a test.

```sh
pnpm --filter @potion.run/example-saas test
```

[`examples/billing`](./examples/billing) is the full Worker: D1 for the event log and the read
models, the API (`/api`), the console (`/admin`), MCP (`/mcp`), the two money routes, and a typed
`Tenant` API over the catalog declarations. `/checkout?tier=pro` asks the provider for a path to pay,
and `/webhooks/*` verifies and applies a delivery with that provider's own decoder. Swap `Manual()`
for `Polar({ ..., webhookSecret })` in
[`billing.config.ts`](./examples/billing/src/billing.config.ts) and the same two routes carry the
whole loop; the test suite already drives them with a fake client, so the loop is proven without a
key.

```sh
pnpm install
pnpm --filter @potion.run/example-billing test
pnpm --filter @potion.run/example-billing dev
```

[`examples/memory`](./examples/memory) is the same model as the smallest deployment: one Worker,
`MemoryStore`, the `Manual` provider, and no database or key. Start here when you want the catalog
and the three paykit paths without the rest of the surface.

```sh
pnpm --filter @potion.run/example-memory test
```

[`examples/polar`](./examples/polar) and [`examples/stripe`](./examples/stripe) are the same loop
sold through a vendor. `PolarBilling` / `StripeBilling` create the product, price, meter and metered
price the catalog states, then hand the ids or lookup keys to the Worker through the environment.
Both tests use a fake vendor client, so neither needs an account.

```sh
pnpm --filter @potion.run/example-polar test
pnpm --filter @potion.run/example-stripe test
```

[`examples/postgres`](./examples/postgres) is the model on Postgres through Cloudflare Hyperdrive.
The connection and the schema are Alchemy's (`Hyperdrive.Connection` / `Connect`,
`@alchemy.run/sql/Postgres`, `@alchemy.run/sql/Migrations`); paykit contributes
`Paykit.postgresExecutor` and the SQL stores. Its integration case is gated on `POSTGRES_URL`.

```sh
pnpm --filter @potion.run/example-postgres test
```

[`examples/auth`](./examples/auth) gates the same model with a
[Better Auth](https://better-auth.com) session, and shows the provider-neutral
`Paykit.SessionFrom` / `Paykit.AdminFrom` resolver that swaps Better Auth for
yielded/auth, a cookie or a deployment's own session service without touching
the catalog or the model.

[`examples/tanstack`](./examples/tanstack) is a TanStack Start app on Cloudflare whose billing UI is
the first-class Effect Atom client. `PaykitAtom.make({ url })` builds one runtime over the tenant
Api — the catalog stays in the Billing Worker, so the browser bundles no copy: `entitlements(account)`
and `billing(account)` are queries, every tenant verb is a command, and a successful command
invalidates the account's reactivity key — so the view refreshes without a manual call.

## The shape of it

- **Entitlement is ours, money is the provider's.** `check()` never calls a provider: it reads a row
  your stack already has. Checkout, cards, tax, invoices and retries sit behind a `Payments` port.
- **The event log is the truth.** Counters, balances and read models are folds of `billing_event`.
  A number that cannot be reproduced by replaying events is a bug, not a cache to invalidate.
- **A command carries the money it recorded.** Prices live on the events, so a catalog change never
  rewrites what an account was sold at.
- **One declaration, several surfaces.** Two `Domain.Api`s serve HTTP, MCP and a CLI; there is no
  second tool list to keep in step.
- **Nothing is deleted on destroy.** The ledger is application data, not stack state.

Read [`packages/paykit/PLAN.md`](./packages/paykit/PLAN.md) for the design of record and
[`AGENTS.md`](./AGENTS.md) for the rules this repo is built by.

## Development

```sh
pnpm format        # oxfmt
pnpm lint          # oxlint, type-aware
pnpm typecheck     # tsrs -b over the project graph
pnpm test          # alchemy-test, per package
pnpm build         # emits lib/ for each published package
```

A published artifact is a different artefact from a passing test suite, so CI also builds and loads
each `lib/index.js` in plain Node — the check that catches a runtime-only import reaching the root.

## Credits

Parts of this repository are adapted from [Alchemy](https://github.com/alchemy-run/alchemy). Thanks
to the Alchemy team.

## License

Apache-2.0.
