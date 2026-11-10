# Memory example

The shortest deployment: one Worker, one catalog, `MemoryStore` and the
`Manual` provider. No database, no provider key, no migrations.

```sh
pnpm install
pnpm --filter @potion.run/example-memory test
pnpm --filter @potion.run/example-memory dev
```

`/api` is the tenant Api, `/checkout?tier=pro` asks the provider for an invoice,
and `/webhooks/*` reports that the manual provider has no delivery to verify.
The model is `Domain.InMemory`, so a restart starts a fresh ledger — that is the
point of the example, and the reason a deployment swaps the store.

| File | What it declares |
| --- | --- |
| `src/catalog.ts` | One meter and two tiers. Plain data, no provider ids. |
| `src/billing.config.ts` | The provider, the catalog and `MemoryStore`, as one declaration. |
| `src/Billing.layer.ts` | That declaration as the world used by the Worker and the test. |
| `src/BillingWorker.ts` | `/api`, `/checkout` and `/webhooks`, from one `Paykit.handler`. |
| `test/example.test.ts` | A sale, a usage fact, the next check, and the money routes. |
| `alchemy.run.ts` | `BillingStack` validates and records the catalog; the Worker is released beside it. |

Start at `examples/billing` for the same catalog on D1, with an operator
console, MCP, and the typed `Tenant` API. The catalog and the binding calls are
the same; only the store, the platform and the surfaces differ.
