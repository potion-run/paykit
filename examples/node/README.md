# Node host

The same paykit model, served by a Node process instead of a Cloudflare Worker. There is no
`Cloudflare.Worker`, no `D1` binding, no Hyperdrive and no deploy resource: `Paykit.handler` is an
`HttpEffect`, and Alchemy's `NodeHttpServer` gives it a `node:http` server. The model, the catalog,
the guards and the money routes are the ones every other example uses.

## What changes

| | Worker example | This example |
| --- | --- | --- |
| HTTP | `Cloudflare.Worker` returns `{ fetch }` | `serve(handler.fetch)` on `node:http` |
| Pooling | one executor per request | one executor per process |
| Deploy | `BillingStack` + `Migrate` Action | none: the process is the deploy |

The store is `MemoryStore` so the example has nothing to provision. A durable Node host provides
the same `Paykit.Database` layers at process scope — `Database/Drizzle` over the `pg` pool the
process already opened, or `Database/Postgres` with a long-lived connection — and calls
`Paykit.sync` at boot or owns its migration pipeline. The server file does not change.

## Run

```sh
pnpm --filter @potion.run/example-node start
```

The process listens on `127.0.0.1:3000`, or `PORT` when set. It is a development host, so the
guards trust the `x-paykit-actor` header.

```sh
curl 'http://127.0.0.1:3000/checkout?tier=pro' -H 'x-paykit-actor: acct_node'
# {"invoiceId":"..."}
```

## Test

```sh
pnpm --filter @potion.run/example-node test
```

`test/example.test.ts` serves the handler on a real `node:http` test server and calls it with the
fetch-backed client, then runs the model directly. The HTTP case is the host proof; the model case
is the same behavior every host owes.

## Files

| File | What it is |
| --- | --- |
| `src/Server.ts` | The handler, `NodeHttpServer`, and `serve` |
| `src/index.ts` | `NodeRuntime.runMain(program)` |
| `src/Billing.layer.ts` | The world, on `MemoryStore` |
| `src/billing.config.ts` | The catalog and the `Manual` provider |
