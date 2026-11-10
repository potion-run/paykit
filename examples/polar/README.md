# Polar example

A Worker that sells one paykit tier through Polar. The deploy provisions the
product, its meter and its metered price with `PolarBilling`, reconciles the
webhook endpoint Polar delivers to at `origin + /webhooks/polar`, and hands the
product id, the meter name and the endpoint's signing secret to the Worker
through its environment. The runtime builds `Polar({ tiers, meters,
webhookSecret })` from those values, so the catalog and the vendor mapping are
stated once.

```sh
POLAR_API_KEY=polar_sandbox_… \
  pnpm --filter @potion.run/example-polar deploy
```

The deploy resolves `POLAR_API_KEY` from the environment, or from the selected
`alchemy profile` (`alchemy profile edit --provider Polar`). The stack is pinned
to `server: "sandbox"`, so a production token cannot create production objects.
It prints the product id and meter name it created, and the Worker receives the
same outputs as bindings. The webhook secret is minted by the endpoint the
deploy creates, so there is no `POLAR_WEBHOOK_SECRET` to set: a hand-managed
endpoint is still possible by passing `webhookSecret` to `PolarBilling`
yourself. `origin` is the app's public origin — the endpoint is created at
`origin + /webhooks/polar`, so point it at the deployment that actually serves
the route.

| File | What it declares |
| --- | --- |
| `src/catalog.ts` | Two tiers and the prices `PolarBilling` copies onto the product. |
| `alchemy.run.ts` | `PolarBilling`, `BillingStack`, and the Worker with the product id, meter name and webhook secret in its env. |
| `src/Billing.ts` | The runtime `Polar` provider, its world, and the two money routes. |
| `src/PolarWorker.ts` | `GET /checkout?tier=pro` and `POST /webhooks/polar`, served by `Paykit.handler`, plus the `/` page this example owns. |
| `test/example.test.ts` | The same routes with a fake Polar client and a signed delivery. |

```sh
pnpm --filter @potion.run/example-polar test   # no Polar account needed
```

The test uses a fake client, so it proves the loop without a token. A deployment
needs a Polar sandbox token; the deploy creates the endpoint and its secret. The
account header is the example's stand-in for a session; a real deployment
resolves its own actor, as `examples/auth` does.
