# Polar example

A Worker that sells one paykit tier through Polar. The deploy provisions the
product, its meter and its metered price with `PolarBilling`, then hands the
product and meter ids to the Worker through its environment. The runtime builds
`Polar({ tiers, meters, webhookSecret })` from those ids, so the catalog and the
vendor mapping are stated once.

```sh
POLAR_ACCESS_TOKEN=polar_sandbox_… \
POLAR_WEBHOOK_SECRET=whsec_… \
pnpm --filter @potion.run/example-polar deploy
```

The stack is pinned to `server: "sandbox"`. It prints the product id and meter
name it created, and the Worker receives the same outputs as bindings:

| File | What it declares |
| --- | --- |
| `src/catalog.ts` | Two tiers and the prices `PolarBilling` copies onto the product. |
| `alchemy.run.ts` | `PolarBilling`, `BillingStack`, and the Worker with the product and meter ids in its env. |
| `src/Billing.ts` | The runtime `Polar` provider, its world, and the two money routes. |
| `src/PolarWorker.ts` | `GET /checkout?tier=pro` and `POST /webhooks/polar`, served by `Paykit.handler`, plus the `/` page this example owns. |
| `test/example.test.ts` | The same routes with a fake Polar client and a signed delivery. |

```sh
pnpm --filter @potion.run/example-polar test   # no Polar account needed
```

The test uses a fake client, so it proves the loop without a token. A deployment
needs a Polar sandbox token and a webhook secret. The account header is the
example's stand-in for a session; a real deployment resolves its own actor, as
`examples/auth` does.
