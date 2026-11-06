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

[`website/`](./website) is the docs site: a private Blume app, deployed as an
Alchemy `Cloudflare.Website.StaticSite`. Run it with `pnpm dev:website` and
build it with `pnpm build:website`.

## Quickstart

```sh
pnpm add @potion.run/paykit alchemy effect
```

```ts
import { Paykit } from "@potion.run/paykit";

const messages = Paykit.feature({ id: "messages", name: "Messages" });
const pro = Paykit.tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [Paykit.allowance(messages, { included: 2_000, overage: "bill" })],
});

// One declaration, read by the deploy, the Worker and the browser client.
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
yield* check({ feature: "messages" });        // { allowed, remaining, resetsAt, standing }

const track = yield* Paykit.TrackUsage(account);
yield* track({ feature: "messages", dedupeKey: requestId });
```

[`examples/billing`](./examples/billing) is a runnable Worker that bills with a real database and no
provider key. It serves the API (`/api`), the console (`/admin`), MCP (`/mcp`), and the two money
routes — `/checkout?tier=pro` asks the provider for a path to pay, and `/webhooks/*` verifies and
applies a delivery with that provider's own decoder. Swap `Manual()` for `Polar({ ..., webhookSecret })`
in [`Billing.ts`](./examples/billing/src/Billing.ts) and the same two routes carry the whole loop;
the test suite already drives them with a fake client, so the loop is proven without a key.

```sh
pnpm install
pnpm --filter @potion.run/example-billing test
pnpm --filter @potion.run/example-billing dev
```

[`examples/auth`](./examples/auth) gates the same model with a
[Better Auth](https://better-auth.com) session, and shows the provider-neutral
`Paykit.SessionFrom` / `Paykit.AdminFrom` resolver that swaps Better Auth for
yielded/auth, a cookie or a deployment's own session service without touching
the catalog or the model.

[`examples/tanstack`](./examples/tanstack) is a TanStack Start app on Cloudflare whose billing UI is
the first-class Effect Atom client. `PaykitAtom.make({ layer })` builds one runtime over the tenant
Api: `entitlements(account)` and `billing(account)` are queries, every tenant verb is a command, and
a successful command invalidates the account's reactivity key — so the view refreshes without a
manual call.

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
pnpm spec          # model-check the TLA+ models in spec/
pnpm test          # alchemy-test, per package
pnpm build         # emits lib/ for each published package
```

[`spec/`](./spec) holds TLA+ models of the parts a test cannot reach: two writers on one account,
a deadline firing mid-flight, a scheduled grant applied at the boundary, an outbox that redelivers, a
process dying between a side effect and the record of it, and a top-up policy that runs twice on one
crossing. `pnpm spec` runs them through `tla-ts` — TLC without the JVM.

A published artifact is a different artefact from a passing test suite, so CI also builds and loads
each `lib/index.js` in plain Node — the check that catches a runtime-only import reaching the root.

## License

Apache-2.0.
